"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { WorldProvider } from "./WorldProvider";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Auth/visibility errors will not fix themselves on retry.
            retry: (count, e) =>
              !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <WorldProvider />
    </QueryClientProvider>
  );
}
