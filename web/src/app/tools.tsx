import type { ReactNode } from "react";
import { WhereIStandPage } from "@/features/where-i-stand/where-i-stand-page";

export interface Tool {
  readonly path: string;
  readonly label: string;
  readonly page: ReactNode;
}

export const tools: readonly Tool[] = [{ path: "where-i-stand", label: "Where I stand", page: <WhereIStandPage /> }];
