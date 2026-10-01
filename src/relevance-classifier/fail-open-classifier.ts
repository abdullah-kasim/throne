import {
  CLASSIFIER_BACKEND_ERROR,
  CLASSIFIER_BUDGET_LOCK_BUSY,
  CLASSIFIER_BUILD_WITHOUT_JEV_LIMITER,
  CLASSIFIER_RATE_LIMITED,
  CLASSIFIER_TIMED_OUT,
  type BackendAnswer,
  type ClassifierAnswer,
  type ClassifierBackend,
  type ClassifierFailure,
  type ClassifierState,
  type FailOpenQuestion,
} from './classifier.types.ts';
import { JevBudgetLockBusyError, JevBudgetUsedUpError, JevBuildWithoutLimiterError } from './jev-backend.ts';
import { RULES_BACKEND } from './rules-backend.ts';

export interface FailOpenDependencies {
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: FailOpenDependencies = {
  writeStderr: (text) => process.stderr.write(text),
};

function safeAnswer(
  question: FailOpenQuestion,
  backend: ClassifierBackend,
  failure?: ClassifierFailure,
): ClassifierAnswer {
  return {
    questionId: question.id,
    pick: question.safePick,
    probability: 0,
    backend: backend.name,
    failedOpen: true,
    ...(failure === undefined ? {} : { failure }),
  };
}

function probabilityOfSafePick(
  question: FailOpenQuestion,
  answer: BackendAnswer,
): number {
  return answer.pick === question.safePick
    ? answer.probability
    : 1 - answer.probability;
}

function isUsableAnswer(
  question: FailOpenQuestion,
  answer: BackendAnswer | undefined,
): answer is BackendAnswer {
  return (
    answer !== undefined &&
    question.choices.includes(answer.pick) &&
    Number.isFinite(answer.probability) &&
    answer.probability >= 0 &&
    answer.probability <= 1
  );
}

function describeFailure(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? ` (HTTP ${String((error as { status: unknown }).status)})`
      : '';
  const name = error instanceof Error ? error.name : 'unknown error';
  return `${name}${status}`;
}

export function isLeftWithoutAnAnswer(answer: ClassifierAnswer, askedBackend: ClassifierBackend): boolean {
  return answer.failedOpen && answer.backend === askedBackend.name;
}

export const DEFAULT_CLASSIFIER_TIMEOUT_MILLISECONDS = 20_000;

class ClassifierTimedOutError extends Error {
  override readonly name = 'ClassifierTimedOutError';
}

function failureOf(error: unknown): ClassifierFailure {
  if (error instanceof ClassifierTimedOutError) return CLASSIFIER_TIMED_OUT;
  if (error instanceof JevBudgetUsedUpError) return CLASSIFIER_RATE_LIMITED;
  if (error instanceof JevBudgetLockBusyError) return CLASSIFIER_BUDGET_LOCK_BUSY;
  if (error instanceof JevBuildWithoutLimiterError) return CLASSIFIER_BUILD_WITHOUT_JEV_LIMITER;
  return CLASSIFIER_BACKEND_ERROR;
}

function isJevBudgetFailure(failure: ClassifierFailure): boolean {
  return (
    failure === CLASSIFIER_RATE_LIMITED ||
    failure === CLASSIFIER_BUDGET_LOCK_BUSY ||
    failure === CLASSIFIER_BUILD_WITHOUT_JEV_LIMITER
  );
}

async function answerWithinTimeout(
  backend: ClassifierBackend,
  state: ClassifierState,
  questions: readonly FailOpenQuestion[],
  timeoutMilliseconds: number,
): Promise<readonly BackendAnswer[]> {
  let timer: NodeJS.Timeout | undefined;
  const abandonment = new AbortController();
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandonment.abort();
      reject(new ClassifierTimedOutError(`no answer within ${timeoutMilliseconds} ms`));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([
      backend.answer(state, questions, abandonment.signal),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface FailOpenOptions {
  readonly timeoutMilliseconds?: number;
  readonly backendWhenTheFirstFails?: ClassifierBackend;
}

export async function askFailingOpen(
  backend: ClassifierBackend,
  state: ClassifierState,
  questions: readonly FailOpenQuestion[],
  dependencies: FailOpenDependencies = PRODUCTION_DEPENDENCIES,
  options: FailOpenOptions = {},
): Promise<readonly ClassifierAnswer[]> {
  if (questions.length === 0) return [];
  let backendAnswers: readonly BackendAnswer[];
  try {
    backendAnswers = await answerWithinTimeout(
      backend,
      state,
      questions,
      options.timeoutMilliseconds ?? DEFAULT_CLASSIFIER_TIMEOUT_MILLISECONDS,
    );
  } catch (error) {
    const failure = failureOf(error);
    const nextBackend = isJevBudgetFailure(failure) ? RULES_BACKEND : options.backendWhenTheFirstFails;
    dependencies.writeStderr(
      `relevance-classifier: the ${backend.name} backend failed with ${describeFailure(error)}; ${
        nextBackend === undefined
          ? 'every question got its safe answer'
          : `the ${nextBackend.name} backend answers instead`
      }.\n`,
    );
    if (nextBackend === undefined) {
      return questions.map((question) => safeAnswer(question, backend, failure));
    }
    const answers = await askFailingOpen(
      nextBackend,
      state,
      questions,
      dependencies,
      { timeoutMilliseconds: options.timeoutMilliseconds },
    );
    return answers.map((answer) => ({ ...answer, failedOpen: true, failure }));
  }
  const answersByQuestionId = new Map(
    backendAnswers.map((answer) => [answer.questionId, answer]),
  );
  let unusableAnswerCount = 0;
  const answers = questions.map((question) => {
    const answer = answersByQuestionId.get(question.id);
    if (!isUsableAnswer(question, answer)) {
      unusableAnswerCount += 1;
      return safeAnswer(question, backend);
    }
    if (
      probabilityOfSafePick(question, answer) >=
      question.minimumProbabilityOfSafePick
    ) {
      return {
        questionId: question.id,
        pick: question.safePick,
        probability: probabilityOfSafePick(question, answer),
        backend: backend.name,
        failedOpen: false,
      };
    }
    return { ...answer, backend: backend.name, failedOpen: false };
  });
  if (unusableAnswerCount > 0) {
    dependencies.writeStderr(
      `relevance-classifier: the ${backend.name} backend left ${unusableAnswerCount} of ${questions.length} questions without a usable answer; each got its safe answer.\n`,
    );
  }
  return answers;
}
