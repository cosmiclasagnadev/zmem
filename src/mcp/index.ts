export interface McpServerHandle {
  close: () => Promise<void>;
}

export async function startMcpServer(): Promise<McpServerHandle> {
  return {
    close: async () => {
      return;
    }
  };
}
