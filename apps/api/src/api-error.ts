import { LeadershipDataError } from "@partner-report/db";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const leadershipStatus = { TEAM_NOT_FOUND: 404, INVALID_DATE_RANGE: 400 } as const;

/** Runs a shared leadership read and reports its failures as API errors. */
export async function leadershipRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof LeadershipDataError)
      throw new ApiError(leadershipStatus[error.code], error.code, error.message);
    throw error;
  }
}
