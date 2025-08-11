'use strict';

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// ====== ENV ======
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const API_KEY = process.env.MCP_API_KEY;
const FORCE_JSON = process.env.MCP_FORCE_JSON === '1'; // if you want to force POST responses to JSON

// ====== OAUTH ======
const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const oauth2Client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
});

// POC: tokens in memory
let savedTokens = null;

// ---- Body parsing ----
// Normal JSON parser for everything except /mcp
app.use((req, res, next) => {
    if (req.path.startsWith('/mcp')) return next();
    return express.json()(req, res, next);
});
// Limited JSON parsing for /mcp
app.use('/mcp', express.json({ limit: '1mb', type: ['application/json', 'application/json; charset=utf-8'] }));

// ---- CORS ----
app.use(
    cors({
        origin: '*', // restrict when everything works (e.g. ['https://claude.ai'])
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'mcp-session-id', 'X-API-Key', 'Authorization'],
        exposedHeaders: ['Mcp-Session-Id'],
    })
);
app.options('*', cors());

// Light logging for /mcp
app.use((req, _res, next) => {
    if (req.path.startsWith('/mcp')) {
        console.log('MCP hit', {
            method: req.method,
            path: req.path,
            hasKey:
                Boolean(req.query.key) ||
                Boolean(req.get('X-API-Key')) ||
                (req.get('Authorization') || '').toLowerCase().startsWith('bearer '),
            sessionId: req.get('Mcp-Session-Id') || req.get('mcp-session-id') || null,
        });
    }
    next();
});

// ---- API key protection (/mcp and /tasks) ----
function requireKey(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const q = req.query.key;
    const x = req.get('X-API-Key');
    const auth = req.get('Authorization');
    const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    const key = q || x || bearer;
    if (API_KEY && key === API_KEY) return next();
    return res.status(401).send('unauthorized');
}

// ====== DEBUG ======
app.get('/debug/envkeys', (req, res) => {
    const keys = Object.keys(process.env).filter((k) => k.startsWith('GOOGLE_'));
    res.json({
        keys,
        id_len: process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.length : 0,
        secret_len: process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.length : 0,
        redirect_len: process.env.GOOGLE_REDIRECT_URI ? process.env.GOOGLE_REDIRECT_URI.length : 0,
    });
});

app.get('/debug/env', (req, res) => {
    res.json({
        has_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
        has_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || null,
    });
});

// ====== OAUTH ======
app.get('/oauth2/start', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        include_granted_scopes: true,
    });
    res.redirect(url);
});

app.get('/oauth2/callback', async (req, res) => {
    try {
        const code = req.query.code?.toString();
        if (!code) return res.status(400).send('missing code');
        const { tokens } = await oauth2Client.getToken(code);
        savedTokens = tokens;
        oauth2Client.setCredentials(tokens);
        res.send('OAuth OK – now go to /tasks (with key)');
    } catch (e) {
        const status = e.response?.status;
        const data = e.response?.data;
        console.error('oauth error', { status, data, message: e.message });
        res.status(500).send(`oauth error: ${data?.error || e.message}`);
    }
});

// ====== GOOGLE TASKS QUICK TEST ======
app.use('/tasks', requireKey);

app.get('/tasks', async (req, res) => {
    try {
        if (!savedTokens) return res.status(401).send('Authorize first at /oauth2/start');
        oauth2Client.setCredentials(savedTokens);

        const at = await oauth2Client.getAccessToken();
        const token = at && at.token;
        if (!token) return res.status(401).send('No access token; try /oauth2/start again');

        const authHeader = { Authorization: `Bearer ${token}` };

        // Lists
        const listsResp = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', { headers: authHeader });
        const lists = await listsResp.json();
        if (!lists.items || lists.items.length === 0) {
            return res.json({ lists: [], tasks: [] });
        }
        const list = lists.items[0];

        // Tasks
        const tasksResp = await fetch(
            `https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks?showCompleted=true`,
            { headers: authHeader }
        );
        const tasks = await tasksResp.json();
        res.json({ list, tasks: tasks.items || [] });
    } catch (err) {
        console.error('tasks error', err);
        res.status(500).send('tasks error');
    }
});

// ====== MCP (Model Context Protocol) ======
let mcpInitPromise;
const sessions = new Map();        // sessionId -> transport
const sessionTimers = new Map();   // sessionId -> timeout
const TTL_MS = 10 * 60 * 1000;     // 10 min

function touchSession(sessionId, transport) {
    if (!sessionId) return;
    const old = sessionTimers.get(sessionId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
        try { transport?.close?.(); } catch { }
        sessions.delete(sessionId);
        sessionTimers.delete(sessionId);
        console.log('MCP session expired (TTL)', { sessionId });
    }, TTL_MS);
    sessionTimers.set(sessionId, t);
}

async function initMcpServer() {
    if (!mcpInitPromise) {
        mcpInitPromise = (async () => {
            const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
            const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
            const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');
            // NOTE: use Zod v3
            const { z } = await import('zod');

            const server = new McpServer({ name: 'google-tasks-mcp', version: '0.1.0' });

            // --- helpers ---
            async function authHeader() {
                if (!savedTokens) return { headers: null, error: 'Not authorized. Visit /oauth2/start first.' };
                oauth2Client.setCredentials(savedTokens);
                const at = await oauth2Client.getAccessToken();
                const token = at && at.token;
                if (!token) return { headers: null, error: 'No access token (re-auth at /oauth2/start)' };
                return {
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    error: null,
                };
            }

            async function listTaskLists(headers) {
                const r = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', { headers });
                const j = await r.json();
                return j.items || [];
            }

            // ---- Tool: search ----
            server.registerTool(
                'search',
                {
                    title: 'Search tasks',
                    description: 'Search tasks by name/status/due date from all lists or a specific list.',
                    // SDK documentation compliant "plain object" style (Zod v3)
                    inputSchema: {
                        query: z.string().describe('Text search in task title').optional(),
                        listId: z.string().describe('Task list ID').optional(),
                        showCompleted: z.boolean().optional(), // defaults handled in handler
                    },
                },
                async ({ query, listId, showCompleted }) => {
                    const show = typeof showCompleted === 'boolean' ? showCompleted : true;
                    const { headers, error } = await authHeader();
                    if (error) return { content: [{ type: 'text', text: error }], isError: true };

                    const lists = listId ? [{ id: listId }] : await listTaskLists(headers);
                    const hits = [];
                    for (const l of lists) {
                        const r = await fetch(
                            `https://tasks.googleapis.com/tasks/v1/lists/${l.id}/tasks?showCompleted=${show}`,
                            { headers }
                        );
                        const j = await r.json();
                        for (const t of (j.items || [])) {
                            if (!query || String(t.title || '').toLowerCase().includes(query.toLowerCase())) {
                                hits.push({ listId: l.id, task: t });
                            }
                        }
                    }
                    return { content: [{ type: 'text', text: JSON.stringify(hits.slice(0, 25), null, 2) }] };
                }
            );

            // ---- Tool: fetch ----
            server.registerTool(
                'fetch',
                {
                    title: 'Fetch a task',
                    description: 'Fetch detailed information for a single task.',
                    inputSchema: {
                        listId: z.string(),
                        taskId: z.string(),
                    },
                },
                async ({ listId, taskId }) => {
                    const { headers, error } = await authHeader();
                    if (error) return { content: [{ type: 'text', text: error }], isError: true };

                    const r = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`, { headers });
                    const j = await r.json();
                    return { content: [{ type: 'text', text: JSON.stringify(j, null, 2) }] };
                }
            );

            // ---- Tool: create_task ----
            server.registerTool(
                'create_task',
                {
                    title: 'Create a task',
                    description: 'Create a new task in the specified list (or the first list if listId is missing).',
                    inputSchema: {
                        listId: z.string().optional(),
                        title: z.string(),
                        notes: z.string().optional(),
                        due: z.string().describe('ISO8601, e.g. 2025-08-01T10:00:00.000Z').optional(),
                    },
                },
                async ({ listId, title, notes, due }) => {
                    const { headers, error } = await authHeader();
                    if (error) return { content: [{ type: 'text', text: error }], isError: true };

                    let targetListId = listId;
                    if (!targetListId) {
                        const lists = await listTaskLists(headers);
                        if (!lists.length) return { content: [{ type: 'text', text: 'No task lists found.' }], isError: true };
                        targetListId = lists[0].id;
                    }

                    const r = await fetch(
                        `https://tasks.googleapis.com/tasks/v1/lists/${targetListId}/tasks`,
                        { method: 'POST', headers, body: JSON.stringify({ title, notes, due }) }
                    );
                    const j = await r.json();
                    return { content: [{ type: 'text', text: JSON.stringify(j, null, 2) }] };
                }
            );

            return { server, StreamableHTTPServerTransport, isInitializeRequest };
        })();
    }
    return mcpInitPromise;
}

// Health for MCP (behind key)
app.get('/mcp/health', requireKey, (req, res) => {
    res.json({ ok: true, name: 'google-tasks-mcp', version: '0.1.0' });
});

// MCP routes: session model (POST init, GET/DELETE maintenance)
app.post('/mcp', requireKey, async (req, res) => {
    try {
        const { server, StreamableHTTPServerTransport, isInitializeRequest } = await initMcpServer();

        // Compatibility: ensure Accept
        const acc = (req.headers['accept'] || '').toLowerCase();
        if (FORCE_JSON) {
            req.headers['accept'] = 'application/json';
        } else if (!acc.includes('application/json') || !acc.includes('text/event-stream')) {
            req.headers['accept'] = 'application/json, text/event-stream';
        }

        const headerId = req.get('Mcp-Session-Id') || req.get('mcp-session-id');
        let transport = headerId ? sessions.get(headerId) : null;

        if (!transport) {
            if (!isInitializeRequest(req.body)) {
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID provided (missing initialize)' },
                    id: null,
                });
            }

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                async onsessioninitialized(sessionId) {
                    sessions.set(sessionId, transport);
                    touchSession(sessionId, transport);
                    console.log('MCP session initialized', { sessionId });
                },
            });

            await server.connect(transport);
        } else {
            touchSession(transport.sessionId, transport);
        }

        res.on('close', () => {
            const sid = transport?.sessionId;
            if (sid) console.log('MCP POST closed (session preserved by TTL)', { sessionId: sid });
        });

        await transport.handleRequest(req, res, req.body);
        touchSession(transport.sessionId, transport);
    } catch (e) {
        console.error('mcp error (POST /mcp)', e);
        res.status(500).json({ error: 'mcp error', message: e.message });
    }
});

const handleSessionReq = async (req, res) => {
    try {
        const headerId = req.get('Mcp-Session-Id') || req.get('mcp-session-id');
        const transport = headerId && sessions.get(headerId);
        if (!transport) return res.status(400).send('Invalid or missing session ID');

        res.on('close', () => {
            const sid = transport?.sessionId;
            if (sid) {
                const t = sessionTimers.get(sid);
                if (t) clearTimeout(t);
                sessionTimers.delete(sid);
                sessions.delete(sid);
                try { transport.close(); } catch { }
                console.log('MCP session closed (GET/DELETE)', { sessionId: sid });
            }
        });

        touchSession(transport.sessionId, transport);
        await transport.handleRequest(req, res);
    } catch (e) {
        console.error(`mcp error (${req.method} /mcp)`, e);
        res.status(500).json({ error: 'mcp error', message: e.message });
    }
};

app.get('/mcp', requireKey, handleSessionReq);
app.delete('/mcp', requireKey, handleSessionReq);

// ====== OTHER ROUTES ======
app.get('/', (req, res) => {
    res.json({
        message: 'Hello from Google Cloud Run!',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/hello', (req, res) => {
    const name = req.query.name || 'World';
    res.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() });
});

// ====== ERROR HANDLING ======
app.use((err, req, res, _next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// 404
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// ====== START ======
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
