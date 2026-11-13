import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { refreshThePage, THE_LORD, writeToTheStore } from "@/features/where-i-stand/page-queries";
import { selectedTabButton } from "@/features/where-i-stand/page-tabs";

export function useStoreAction(announce: (message: string) => void) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState("");
  async function act(path: string, doneWords: string, notDoneWords: string) {
    const answer = await writeToTheStore("POST", path, { writer: THE_LORD }, notDoneWords);
    const words = answer.outcome === "done" ? doneWords : answer.message;
    setProblem(answer.outcome === "done" ? "" : words);
    await refreshThePage(queryClient);
    announce(words);
  }
  return { act, problem };
}

interface ArchiveControlProps {
  readonly name: string;
  readonly what: "row" | "section";
  readonly path: string;
  readonly announce: (message: string) => void;
}

export function ArchiveControl({ name, what, path, announce }: ArchiveControlProps) {
  const { act, problem } = useStoreAction(announce);
  const where = what === "row" ? "its section" : "this tab";
  const trigger = useRef<HTMLButtonElement>(null);

  function focusTheTabWhenTheControlHasLeft(event: Event) {
    if (trigger.current?.isConnected) return;
    event.preventDefault();
    selectedTabButton()?.focus();
  }

  return (
    <span className="archive-control">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button ref={trigger} type="button" variant="outline" size="sm" aria-label={what === "row" ? `Archive ${name}` : `Archive section ${name}`}>
            Archive
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="[overflow-wrap:anywhere] data-[state=closed]:animate-none!" onCloseAutoFocus={focusTheTabWhenTheControlHasLeft}>
          <AlertDialogHeader>
            <AlertDialogTitle>{what === "row" ? `Archive '${name}'?` : `Archive the section '${name}'?`}</AlertDialogTitle>
            <AlertDialogDescription>{`It moves under Archived at the foot of ${where}, where you can restore it. Archived ${what}s are deleted after six months.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void act(`${path}/archive`, `Archived ${name}.`, "Not archived")}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {problem !== "" && <span className="unit-status problem">{problem}</span>}
    </span>
  );
}

export function RestoreControl({ name, path, announce }: Omit<ArchiveControlProps, "what">) {
  const { act, problem } = useStoreAction(announce);
  return (
    <span className="archive-control">
      <Button type="button" variant="outline" size="sm" aria-label={`Restore ${name}`} onClick={() => void act(`${path}/restore`, `Restored ${name}.`, "Not restored")}>
        Restore
      </Button>
      {problem !== "" && <span className="unit-status problem">{problem}</span>}
    </span>
  );
}
