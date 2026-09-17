export async function withModelFailover<T>(options: {
  model: string;
  invoke: (model: string) => Promise<T>;
  alternatives: () => Promise<string[]>;
  checkActive: () => void;
  warning: (message: string) => void;
}): Promise<T> {
  let models = [options.model];
  let lastError: unknown;
  for (let index = 0; index < models.length; index++) {
    options.checkActive();
    try { return await options.invoke(models[index]); }
    catch (error) {
      options.checkActive(); // Cancellation must never trigger more provider calls.
      lastError = error;
      options.warning(`${models[index]} could not complete this step: ${error instanceof Error ? error.message : "Unknown error"}`);
      if (index === 0) {
        const alternatives = await options.alternatives();
        models = [...new Set([options.model, ...alternatives])];
      }
      if (models[index + 1]) options.warning(`Continuing this step with ${models[index + 1]}.`);
    }
  }
  throw new Error(`No available model completed this step. Last error: ${lastError instanceof Error ? lastError.message : "No response"}`);
}
