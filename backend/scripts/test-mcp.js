// Test that routes/mcp.js can be imported without errors
import { createMcpHandler } from '../routes/mcp.js';
console.log('✅ createMcpHandler imported:', typeof createMcpHandler);
console.log('🎉 MCP route module loads correctly!');
process.exit(0);
