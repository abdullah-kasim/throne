# Coding a feature

**Read [`coding_principles.md`](./coding_principles.md) first.** The "no surprises" diagnostic and the SRP / DRY-with-guardrails / self-documenting-code / contracts / fewer-codepaths principles apply to every feature you write. The notes below are feature-specific workflow on top of those principles.

## The gist.

1. Write feature
2. Write tests.

### On writing features

1. Go for it
2. **DO NOT refactor unrelated code.** Only touch code directly required for the feature. No "cleanup passes", no removing optional chaining you think is unnecessary, no type annotation changes to unrelated code, no style fixes outside your feature. If you didn't need to change it for the feature to work, don't change it.

### On writing tests:

1. Do not create an artifical environment, rely on actual environment.
2. DO NOT replace the functions that you're testing.
3. Write tests without any mocking first, then slowly mock your way:
    1. First try to mock API calls. Try several times.
    2. If that fails ater several tries. Try `spy`ing external function calls i.e. mock the logger.
    3. If even that fails, then maybe you need a refactor to have an API to be called (even if it's fake one), or have it called a logger, or even, make certain functionalites external i.e. the API called can be moved to a separate file, and THEN we mock that separate file.
    4. Basically DO NOT, I REPEAT, DO NOT MOCK the file that you yourself is testing.
4. Verify call counts on mocked dependencies to catch unintended behavior - e.g., if a service should call an API once, assert `toHaveBeenCalledTimes(1)` to catch accidental loops or missing calls.
