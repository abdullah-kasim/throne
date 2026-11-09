import { healthResponse } from "@contract/health.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchParsed } from "@/lib/api-client";

const HEALTH_CHECK_INTERVAL_MILLISECONDS = 60000;
const ASKING_WORDS = "Asking the backend";

export function BackendHealth() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => fetchParsed("health", healthResponse), refetchInterval: HEALTH_CHECK_INTERVAL_MILLISECONDS });
  const [wordsOfLastAnswer, setWordsOfLastAnswer] = useState(ASKING_WORDS);
  const wordsWhenAnswering = health.data?.ok ? "The backend answered" : wordsOfLastAnswer;
  const words = health.isError ? `The backend did not answer: ${health.error.message}` : wordsWhenAnswering;
  if (words !== wordsOfLastAnswer) setWordsOfLastAnswer(words);
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {words}
    </p>
  );
}
