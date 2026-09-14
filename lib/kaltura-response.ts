/** Kaltura can return HTTP 200 with an API exception; never cache that as metadata. */
export function validateKalturaResponse(body: string): void {
  const data: unknown = JSON.parse(body);
  if (
    !Array.isArray(data) ||
    data.length < 2 ||
    data.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        entry.objectType === "KalturaAPIException" ||
        typeof entry.code === "string",
    )
  ) {
    throw new Error("Invalid Kaltura metadata response");
  }
}
