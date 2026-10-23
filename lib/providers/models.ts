export function getAnalysisModel(): string {
  return process.env.STT_ANALYSIS_MODEL || "gpt-6.1-sol";
}

export function getAnalysisModelMini(): string {
  return process.env.STT_ANALYSIS_MODEL_MINI || "gpt-6-luna";
}

export function getAnalysisModelNano(): string {
  return process.env.STT_ANALYSIS_MODEL_NANO || "gpt-6-luna";
}
