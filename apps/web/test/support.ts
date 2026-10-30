/** What `promise` rejects with. A test that expects a rejection fails when there is none. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection, but the promise resolved");
}
