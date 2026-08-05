export type KnownSession = {
  contentHash?: string;
  contentHashes?: string[];
  decision: "accepted" | "ignored";
};

type ProcessedSession = { contentHash: string };

export function knownContentHashes(known: KnownSession) {
  return [
    ...new Set([...(known.contentHashes ?? []), known.contentHash]),
  ].filter((value): value is string => Boolean(value));
}

function mergeKnownSession(
  sessions: Record<string, KnownSession>,
  sessionKey: string,
  contentHash: string,
  decision: KnownSession["decision"],
  override = false,
) {
  const existing = sessions[sessionKey];
  sessions[sessionKey] =
    !override && existing?.decision === decision
      ? {
          decision,
          contentHashes: [
            ...new Set([...knownContentHashes(existing), contentHash]),
          ],
        }
      : { decision, contentHashes: [contentHash] };
}

export function buildKnownSessionIndex(input: {
  remoteAccepted: Array<{ sessionKey: string; contentHash: string }>;
  localAccepted: Record<string, ProcessedSession>;
  localIgnored: Record<string, ProcessedSession>;
}) {
  const sessions: Record<string, KnownSession> = {};
  for (const session of input.remoteAccepted) {
    mergeKnownSession(
      sessions,
      session.sessionKey,
      session.contentHash,
      "accepted",
    );
  }
  for (const [sessionKey, accepted] of Object.entries(input.localAccepted)) {
    mergeKnownSession(sessions, sessionKey, accepted.contentHash, "accepted");
  }
  for (const [sessionKey, ignored] of Object.entries(input.localIgnored)) {
    mergeKnownSession(
      sessions,
      sessionKey,
      ignored.contentHash,
      "ignored",
      true,
    );
  }
  return sessions;
}

export function matchingKnownDecision(
  known: KnownSession | undefined,
  candidateHashes: Iterable<string>,
) {
  if (!known) return null;
  const candidates = new Set(candidateHashes);
  return knownContentHashes(known).some((hash) => candidates.has(hash))
    ? known.decision
    : null;
}
