import { Activity, useEffect, useRef, useState, type RefObject } from "react";
import { NavLink, Outlet, useMatch } from "react-router";
import { BackendHealth } from "@/app/backend-health";
import { tools, type Tool } from "@/app/tools";

function useFocusHandedToItsLinkWhenToolHides(tool: Tool, isAtItsAddress: boolean, shellLinks: RefObject<HTMLElement | null>) {
  const focusedBeforeThisRender = document.activeElement;
  const wasAtItsAddress = useRef(isAtItsAddress);
  useEffect(() => {
    const toolJustHid = wasAtItsAddress.current && !isAtItsAddress;
    wasAtItsAddress.current = isAtItsAddress;
    const focusWasOnAShellControl = shellLinks.current?.contains(focusedBeforeThisRender);
    if (toolJustHid && !focusWasOnAShellControl) shellLinks.current?.querySelector<HTMLElement>(`[data-tool-path="${tool.path}"]`)?.focus();
  });
}

function ToolKeptOnceOpened({ tool, shellLinks }: { tool: Tool; shellLinks: RefObject<HTMLElement | null> }) {
  const isAtItsAddress = useMatch(tool.path) !== null;
  const [wasOpened, setWasOpened] = useState(isAtItsAddress);
  if (isAtItsAddress && !wasOpened) setWasOpened(true);
  useFocusHandedToItsLinkWhenToolHides(tool, isAtItsAddress, shellLinks);
  return wasOpened && <Activity mode={isAtItsAddress ? "visible" : "hidden"}>{tool.page}</Activity>;
}

export function AppShell() {
  const shellLinks = useRef<HTMLElement>(null);
  return (
    <div className="mx-auto flex min-h-screen max-w-[792px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-xl font-semibold">Throne</p>
        <nav ref={shellLinks} className="flex gap-3">
          {tools.map((tool) => (
            <NavLink key={tool.path} to={tool.path} data-tool-path={tool.path} className="underline underline-offset-4 aria-[current=page]:font-semibold">
              {tool.label}
            </NavLink>
          ))}
        </nav>
        <BackendHealth />
      </header>
      <main>
        <Outlet />
        {tools.map((tool) => (
          <ToolKeptOnceOpened key={tool.path} tool={tool} shellLinks={shellLinks} />
        ))}
      </main>
    </div>
  );
}
