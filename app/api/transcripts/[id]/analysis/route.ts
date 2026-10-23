// Runs on-demand proposition analysis on a completed transcript.
import { NextRequest, NextResponse } from "next/server";
import { AzureOpenAI } from "openai";
import { analyzePropositions } from "@/lib/pipeline";
import {
  getTranscriptById,
  updateTranscriptContent,
  claimAnalysis,
  releaseAnalysis,
} from "@/lib/db";
import { getSpeakerMapping } from "@/lib/speakers";
import { currentWorkerId } from "@/lib/worker-identity";
import { apiError } from "@/lib/api-error";
import { requireExperimental } from "@/lib/auth/require-experimental";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    // Analysis is an experimental feature.
    const auth = await requireExperimental();
    if (auth.response) return auth.response;

    const { id: transcriptId } = await context.params;

    if (!transcriptId) {
      return apiError(400, "missing_parameter", "Transcript ID required");
    }

    const transcript = await getTranscriptById(transcriptId);
    if (!transcript || transcript.suppressed_at) {
      return apiError(404, "not_found", "Transcript not found");
    }

    const statements = transcript.content.statements;
    if (!statements || statements.length === 0) {
      return apiError(400, "missing_data", "No processed statements available");
    }

    const speakerMapping = await getSpeakerMapping(transcriptId);
    if (!speakerMapping || Object.keys(speakerMapping).length === 0) {
      return apiError(
        400,
        "missing_speakers",
        "No speaker mapping available — run transcription first",
      );
    }

    // Atomic status CAS on the analysis axis: claim from `none | completed |
    // error | interrupted` (any non-running state) and transition to
    // `analyzing` while stamping worker_id + heartbeat_at. A concurrent
    // request that races us gets rowCount=0 and returns 409.
    const claimed = await claimAnalysis(
      transcriptId,
      ["none", "completed", "error", "interrupted"],
      "analyzing",
      currentWorkerId(),
    );
    if (!claimed) {
      return apiError(409, "analysis_in_progress", "Analysis already running");
    }

    try {
      const client = new AzureOpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiVersion:
          process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
      });

      const propositions = await analyzePropositions(
        statements,
        speakerMapping,
        client,
        transcriptId,
        transcript.language_code ?? undefined,
      );

      await updateTranscriptContent(transcriptId, {
        ...transcript.content,
        propositions,
      });

      await releaseAnalysis(transcriptId, "completed");

      return NextResponse.json({ propositions });
    } catch (error) {
      await releaseAnalysis(
        transcriptId,
        "error",
        error instanceof Error ? error.message : "Analysis failed",
      );
      throw error;
    }
  } catch (error) {
    console.error("Proposition analysis error:", error);
    return apiError(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
