import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Função de segurança que limpa todos os dados do cache do React Query para evitar
 * que informações sensíveis de um usuário sejam visíveis para outro após logout, 
 * troca de usuário, ou recarregamento da página.
 * 
 * Esta função é chamada:
 * 1. Ao fazer login
 * 2. Ao fazer logout
 * 3. Ao criar uma nova conta
 * 4. Ao recarregar a página (via event listener beforeunload)
 * 
 * A limpeza do cache é uma medida crítica de segurança para prevenir vazamento
 * de dados entre usuários, especialmente em ambientes onde múltiplos usuários
 * podem compartilhar o mesmo dispositivo ou em cenários de navegação privada
 * onde o cache persiste na sessão.
 */
export const clearCacheForSecurity = () => {
  // Remove TODAS as queries armazenadas no cache do React Query
  // Isso garante que nenhum dado sensível permaneça no cache
  queryClient.clear();
  
  // Log para ajudar no debug e auditoria de segurança
  console.log('Cache limpo por questões de segurança');
};
