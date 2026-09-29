import {
  publicSpeakerMapping,
  type DisplaySpeakerMapping as SpeakerMapping,
} from "./public-speakers";
import {
  getPendingTranscriptByKalturaId,
  getSpeakerMapping,
  isTranscriptFlagged,
  type AnalysisStatus,
  type Transcript,
  type TranscriptContent,
  type TranscriptionStatus,
} from "./db";
import { stripWordsFromStatements } from "./strip-words";
import { filterOffRecord } from "./off-record";

/**
 * The one package of transcript facts every display surface receives —
 * whether server-rendered (components/server-transcript.tsx) or fetched
 * (/api/transcripts/check). Both producers MUST go through
 * buildTranscriptPayload(); the shared shape is what prevents the two paths
 * from drifting apart (a field added here reaches both, or the build fails —
 * previously `flagged` and `analysisStatus` were each wired into only one
 * path and silently dead on the other).
 *
 * Word-level timestamps are intentionally absent — the panel fetches them
 * lazily from /api/transcripts/[id]/words once the transcript is on screen.
 */
export interface TranscriptPayload {
  statements: TranscriptContent["statements"];
  speakerMappings: SpeakerMapping;
  topics: NonNullable<TranscriptContent["topics"]>;
  /** Experimental: empty for viewers without experimental access. */
  propositions: NonNullable<TranscriptContent["propositions"]>;
  transcriptId: string;
  language: string | null;
  analysisStatus: AnalysisStatus;
  /**
   * WebTV re-cut the audio after transcription and the realignment cron
   * couldn't resolve it with a single front-shift (lib/db.ts
   * isTranscriptFlagged) — timestamps are off; surfaces the out-of-sync
   * disclaimer + re-transcribe affordance.
   */
  flagged: boolean;
  sourceDurationMs: number | null;
  alignedDurationMs: number | null;
  /** In-flight fresh transcription replacing a flagged row, if any. */
  pendingRetranscribeId: string | null;
  pendingRetranscribeStage: TranscriptionStatus | null;
}

export async function buildTranscriptPayload(
  transcript: Transcript,
  { experimentalAccess }: { experimentalAccess: boolean },
): Promise<TranscriptPayload> {
  const fullMapping = (await getSpeakerMapping(transcript.transcript_id)) || {};
  // Off-record statements are stored but never served (lib/off-record.ts).
  const { statements: visibleStatements, speakerMappings } = filterOffRecord(
    transcript.content.statements,
    fullMapping,
  );
  const flagged = isTranscriptFlagged(transcript);
  // A pending replacement is only meaningful for flagged rows, so the extra
  // lookup is confined to them.
  const pending =
    flagged && transcript.language_code
      ? await getPendingTranscriptByKalturaId(
          transcript.kaltura_id,
          transcript.language_code,
        )
      : null;
  return {
    statements: stripWordsFromStatements(visibleStatements),
    speakerMappings: experimentalAccess
      ? speakerMappings
      : publicSpeakerMapping(speakerMappings, visibleStatements.length),
    topics: transcript.content.topics || {},
    propositions: experimentalAccess
      ? transcript.content.propositions || []
      : [],
    transcriptId: transcript.transcript_id,
    language: transcript.language_code,
    analysisStatus: transcript.analysis_status,
    flagged,
    sourceDurationMs: transcript.source_duration_ms,
    alignedDurationMs: transcript.aligned_duration_ms,
    pendingRetranscribeId: pending?.transcript_id ?? null,
    pendingRetranscribeStage: pending?.transcription_status ?? null,
  };
}
