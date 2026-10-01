import { readFile, realpath } from 'node:fs/promises';
import {
  NO,
  YES,
  YES_OR_NO_CHOICES,
  type BackendAnswer,
  type ClassifierBackend,
  type ClassifierQuestion,
  type ClassifierState,
} from './classifier.types.ts';
import {
  JEV_BUDGET_GRANTED,
  JEV_BUDGET_LOCK_BUSY,
  JEV_BUDGET_REFUSED,
  reserveJevTokens,
  settleJevReservation,
  type JevLimits,
  type JevReservation,
} from './jev-budget.ts';
import {
  JEV_LIMITER_VERSION,
  isInsideTheLiveCheckoutBuild,
  type JevLimiterBuild,
} from './jev-limiter-build.ts';
import {
  appendJevUsageLine,
  type JevCallerKind,
  type JevRequestOutcome,
} from './jev-usage-log.ts';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_TIMEOUT_MILLISECONDS = 8000;
export const JEV_MAXIMUM_RETRIES = 1;
export const JEV_REQUEST_TOKEN_LIMIT = 64_000;
export const JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT = 32_000;
const CHARACTERS_PER_ESTIMATED_TOKEN = 3;
const ESTIMATED_TOKENS_OF_OVERHEAD_PER_QUESTION = 16;
const SHARE_OF_EACH_LIMIT_WE_FILL = 0.9;

export async function thisJevLimiterBuild(): Promise<JevLimiterBuild> {
  return {
    limiterVersion: JEV_LIMITER_VERSION,
    runsFromTheLiveCheckout: await isInsideTheLiveCheckoutBuild(await realpath(import.meta.filename)),
  };
}

export type JevQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, null>>;
    };

export type JevResponse =
  | { readonly type: 'noul'; readonly noul: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'score' };

export interface JevClient {
  systemOne(
    request: {
      readonly state: ClassifierState;
      readonly questions: Record<string, JevQuestion>;
    },
    options?: { readonly signal?: AbortSignal },
  ): PromiseLike<JevReply>;
}

export interface JevReply {
  readonly answers: Readonly<Record<string, JevResponse>>;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

export interface JevBudget {
  readonly dataHome: string;
  readonly limits: JevLimits;
  readonly caller: JevCallerKind;
  readonly invocationId?: string;
}

export interface JevBackendDependencies {
  readKeyFile(keyFilePath: string): Promise<string>;
  createClient(apiKey: string): Promise<JevClient>;
}

export const PRODUCTION_JEV_DEPENDENCIES: JevBackendDependencies = {
  readKeyFile: (keyFilePath) => readFile(keyFilePath, 'utf8'),
  createClient: async (apiKey) => {
    const { TypeSafeClient } = await import('@typesafe-ai/sdk');
    return new TypeSafeClient({
      apiKey,
      defaultModel: JEV_MODEL,
      timeout: JEV_TIMEOUT_MILLISECONDS,
      retry: { maxRetries: JEV_MAXIMUM_RETRIES },
      logLevel: 'off',
    });
  },
};

class JevKeyUnavailableError extends Error {
  override readonly name = 'JevKeyUnavailableError';
}

export class JevBudgetUsedUpError extends Error {
  override readonly name = 'JevBudgetUsedUpError';
}

export class JevBudgetLockBusyError extends Error {
  override readonly name = 'JevBudgetLockBusyError';
}

export class JevBuildWithoutLimiterError extends Error {
  override readonly name = 'JevBuildWithoutLimiterError';
}

export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_ESTIMATED_TOKEN);
}

function estimatedQuestionTokens(question: ClassifierQuestion): number {
  return (
    estimatedTokens(question.instructions + question.choices.join(' ')) +
    ESTIMATED_TOKENS_OF_OVERHEAD_PER_QUESTION
  );
}

function estimatedStateTokens(state: ClassifierState): number {
  return estimatedTokens(
    typeof state === 'string' ? state : JSON.stringify(state),
  );
}

export function estimatedRequestTokens(
  state: ClassifierState,
  questions: readonly ClassifierQuestion[],
): number {
  return questions.reduce(
    (total, question) => total + estimatedQuestionTokens(question),
    estimatedStateTokens(state),
  );
}

function withLongestFieldShortenedBy(
  state: Readonly<Record<string, string>>,
  charactersToRemove: number,
): Readonly<Record<string, string>> {
  const [longestField] = Object.keys(state).sort(
    (left, right) => (state[right] ?? '').length - (state[left] ?? '').length,
  );
  if (longestField === undefined) return state;
  const longestText = state[longestField] ?? '';
  return {
    ...state,
    [longestField]: longestText.slice(
      0,
      Math.max(0, longestText.length - charactersToRemove),
    ),
  };
}

export function stateWithinJevLimit<State extends ClassifierState>(
  state: State,
  questions: readonly ClassifierQuestion[],
): State {
  const longestQuestionTokens = Math.max(
    0,
    ...questions.map(estimatedQuestionTokens),
  );
  const stateTokenBudget = Math.max(
    0,
    Math.floor(
      JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT * SHARE_OF_EACH_LIMIT_WE_FILL,
    ) - longestQuestionTokens,
  );
  if (typeof state === 'string') {
    return state.slice(
      0,
      stateTokenBudget * CHARACTERS_PER_ESTIMATED_TOKEN,
    ) as State;
  }
  const tokensOverBudget = estimatedStateTokens(state) - stateTokenBudget;
  return (
    tokensOverBudget <= 0
      ? state
      : withLongestFieldShortenedBy(
          state,
          tokensOverBudget * CHARACTERS_PER_ESTIMATED_TOKEN,
        )
  ) as State;
}

export function questionsSplitAcrossRequests(
  state: ClassifierState,
  questions: readonly ClassifierQuestion[],
): readonly (readonly ClassifierQuestion[])[] {
  const questionTokenBudget =
    Math.floor(JEV_REQUEST_TOKEN_LIMIT * SHARE_OF_EACH_LIMIT_WE_FILL) -
    estimatedStateTokens(state);
  const requests: ClassifierQuestion[][] = [];
  let currentRequest: ClassifierQuestion[] = [];
  let currentRequestTokens = 0;
  for (const question of questions) {
    const questionTokens = estimatedQuestionTokens(question);
    if (
      currentRequest.length > 0 &&
      currentRequestTokens + questionTokens > questionTokenBudget
    ) {
      requests.push(currentRequest);
      currentRequest = [];
      currentRequestTokens = 0;
    }
    currentRequest.push(question);
    currentRequestTokens += questionTokens;
  }
  if (currentRequest.length > 0) requests.push(currentRequest);
  return requests;
}

function isYesOrNoQuestion(question: ClassifierQuestion): boolean {
  return (
    question.choices.length === YES_OR_NO_CHOICES.length &&
    YES_OR_NO_CHOICES.every((choice) => question.choices.includes(choice))
  );
}

function asJevQuestion(question: ClassifierQuestion): JevQuestion {
  if (isYesOrNoQuestion(question)) {
    return { type: 'noul', instructions: question.instructions };
  }
  return {
    type: 'choice',
    instructions: question.instructions,
    criteria: Object.fromEntries(
      question.choices.map((choice) => [choice, null]),
    ),
  };
}

function asBackendAnswer(
  question: ClassifierQuestion,
  response: JevResponse | undefined,
): BackendAnswer | undefined {
  if (response?.type === 'noul') {
    return response.noul >= 0.5
      ? { questionId: question.id, pick: YES, probability: response.noul }
      : { questionId: question.id, pick: NO, probability: 1 - response.noul };
  }
  if (response?.type === 'choice') {
    const probability = response.probabilities[response.choice];
    return probability === undefined
      ? undefined
      : { questionId: question.id, pick: response.choice, probability };
  }
  return undefined;
}

interface AnsweredRequest {
  readonly answers: readonly BackendAnswer[];
  readonly realTokens: number | undefined;
}

async function answerOneRequest(
  client: JevClient,
  state: ClassifierState,
  questions: readonly ClassifierQuestion[],
  abandoned: AbortSignal | undefined,
): Promise<AnsweredRequest> {
  const questionsByRequestName = new Map(
    questions.map((question, index) => [`question_${index}`, question]),
  );
  const { answers, usage } = await client.systemOne(
    {
      state,
      questions: Object.fromEntries(
        [...questionsByRequestName].map(([requestName, question]) => [
          requestName,
          asJevQuestion(question),
        ]),
      ),
    },
    abandoned === undefined ? {} : { signal: abandoned },
  );
  return {
    answers: [...questionsByRequestName].flatMap(([requestName, question]) => {
      const answer = asBackendAnswer(question, answers[requestName]);
      return answer === undefined ? [] : [answer];
    }),
    realTokens: usage === undefined ? undefined : usage.input_tokens + usage.output_tokens,
  };
}

async function logJevRequest(
  budget: JevBudget,
  estimatedTokens: number,
  realTokens: number | undefined,
  outcome: JevRequestOutcome,
): Promise<void> {
  await appendJevUsageLine(budget.dataHome, {
    at: new Date().toISOString(),
    caller: budget.caller,
    estimatedTokens,
    realTokens: realTokens ?? null,
    outcome,
    invocationId: budget.invocationId,
  });
}

type UnsentReservation = Exclude<JevReservation, { readonly outcome: typeof JEV_BUDGET_GRANTED }>;

function usageOutcomeOf(reservation: UnsentReservation): JevRequestOutcome {
  if (reservation.outcome === JEV_BUDGET_REFUSED) return 'rate-limited';
  if (reservation.outcome === JEV_BUDGET_LOCK_BUSY) return 'lock-busy';
  return 'outdated-build';
}

async function logUnsentRequests(
  budget: JevBudget,
  estimates: readonly number[],
  reservation: UnsentReservation,
): Promise<void> {
  const outcome = usageOutcomeOf(reservation);
  for (const estimate of estimates) await logJevRequest(budget, estimate, undefined, outcome);
}

function budgetErrorOf(reservation: UnsentReservation): Error {
  if (reservation.outcome === JEV_BUDGET_REFUSED) {
    return new JevBudgetUsedUpError(
      `the Jev budget of ${reservation.limitTokens} ${reservation.limit} is used up (${reservation.spentTokens} spent)`,
    );
  }
  if (reservation.outcome === JEV_BUDGET_LOCK_BUSY) {
    return new JevBudgetLockBusyError('the Jev budget lock stayed busy');
  }
  return new JevBuildWithoutLimiterError(
    `this build's Jev limiter version ${JEV_LIMITER_VERSION} is older than version ${reservation.recordedLimiterVersion}, which the live build has spent with`,
  );
}

interface EstimatedRequest {
  readonly questions: readonly ClassifierQuestion[];
  readonly estimatedTokens: number;
}

interface ReservedRequest extends EstimatedRequest {
  readonly reservationId: string;
}

async function answerOneReservedRequest(
  clientCreatedOnFirstUse: () => Promise<JevClient>,
  state: ClassifierState,
  request: ReservedRequest,
  budget: JevBudget,
  abandoned: AbortSignal | undefined,
): Promise<readonly BackendAnswer[]> {
  let answered: AnsweredRequest;
  try {
    answered = await answerOneRequest(await clientCreatedOnFirstUse(), state, request.questions, abandoned);
  } catch (error) {
    await logJevRequest(budget, request.estimatedTokens, undefined, 'failed');
    throw error;
  }
  await settleJevReservation(budget.dataHome, request.reservationId, answered.realTokens, new Date());
  await logJevRequest(budget, request.estimatedTokens, answered.realTokens, 'answered');
  return answered.answers;
}

async function readApiKey(
  keyFilePath: string,
  dependencies: JevBackendDependencies,
): Promise<string> {
  let apiKey: string;
  try {
    apiKey = (await dependencies.readKeyFile(keyFilePath)).trim();
  } catch {
    throw new JevKeyUnavailableError('the Jev key file could not be read');
  }
  if (apiKey.length === 0) {
    throw new JevKeyUnavailableError('the Jev key file is empty');
  }
  return apiKey;
}

export function createJevBackend(
  keyFilePath: string,
  budget: JevBudget,
  dependencies: JevBackendDependencies = PRODUCTION_JEV_DEPENDENCIES,
): ClassifierBackend {
  let clientOnceCreated: Promise<JevClient> | undefined;
  const clientCreatedOnFirstUse = (): Promise<JevClient> => {
    clientOnceCreated ??= readApiKey(keyFilePath, dependencies)
      .then((apiKey) => dependencies.createClient(apiKey))
      .catch((error: unknown) => {
        clientOnceCreated = undefined;
        throw error;
      });
    return clientOnceCreated;
  };
  return {
    name: 'jev',
    answer: async (state, questions, abandoned) => {
      const stateWithinLimit = stateWithinJevLimit(state, questions);
      const requests: readonly EstimatedRequest[] = questionsSplitAcrossRequests(stateWithinLimit, questions).map(
        (requestQuestions) => ({
          questions: requestQuestions,
          estimatedTokens: estimatedRequestTokens(stateWithinLimit, requestQuestions),
        }),
      );
      const estimates = requests.map((request) => request.estimatedTokens);
      const reservation = await reserveJevTokens(
        budget.dataHome,
        budget.limits,
        estimates,
        new Date(),
        await thisJevLimiterBuild(),
      );
      if (reservation.outcome !== JEV_BUDGET_GRANTED) {
        await logUnsentRequests(budget, estimates, reservation);
        throw budgetErrorOf(reservation);
      }
      const answersPerRequest = await Promise.all(
        requests.map((request, index) =>
          answerOneReservedRequest(
            clientCreatedOnFirstUse,
            stateWithinLimit,
            { ...request, reservationId: reservation.reservationIds[index] as string },
            budget,
            abandoned,
          ),
        ),
      );
      return answersPerRequest.flat();
    },
  };
}
