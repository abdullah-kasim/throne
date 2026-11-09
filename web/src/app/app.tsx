import { WEB_APP_MOUNT_PATH } from "@contract/web-app-mount.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "@/app/app-shell";
import { tools } from "@/app/tools";

const NO_PAGE_WORDS = "There is no page at this address.";

function routerBasename(pathname: string): string {
  const isUnderTheMount = pathname === WEB_APP_MOUNT_PATH || pathname.startsWith(`${WEB_APP_MOUNT_PATH}/`);
  return isUnderTheMount ? WEB_APP_MOUNT_PATH : "/";
}

function createAppQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always", refetchOnReconnect: true, gcTime: Infinity } } });
}

export function App() {
  const [queryClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={routerBasename(window.location.pathname)}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            {tools.map(({ path }) => (
              <Route key={path} path={path} />
            ))}
            <Route path="*" element={<p>{NO_PAGE_WORDS}</p>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
