#!/usr/bin/env node

/**
 * Muibook Model Context Protocol (MCP) Server
 * 
 * Exposes the structured knowledge of the Muibook component library to AI assistants
 * (Antigravity, OpenCode, GPT, Codex, Claude Code, Claude Desktop, etc.).
 * 
 * Supports both stdio (default) and SSE (HTTP) transport modes.
 * 
 * Run in SSE mode:
 *   node mcp-server.js --sse
 *   node mcp-server.js --port 22222
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');
const url = require('url');

// --- Helper: TypeScript to JavaScript converter ---
function tsToJs(tsCode) {
  return tsCode
    // Remove TS 4.9 "satisfies" clauses used after object literals
    .replace(/\s+satisfies\s+Record<keyof typeof compositions,\s*\{[\s\S]*?\}>\s*;/g, ';')
    // Remove Pick typecast
    .replace(/\s+as\s+Pick<[^>]+>/g, '')
    // Remove simple type assertions in expressions (e.g., "as CompositionKey[]")
    .replace(/\s+as\s+[A-Za-z_$][\w$]*(?:\[\])?/g, '')
    // Remove type annotations on variables (e.g., ": Record<string, string[]>")
    .replace(/:\s*Record<[^>]+>/g, '')
    // Remove "as const"
    .replace(/\s+as\s+const\b/g, '')
    // Remove type declarations (e.g., "export type AgentKeywordKey = ...")
    .replace(/^\s*(?:export\s+)?type\s+\w+\s*=\s*[^;]+;\s*$/gm, '')
    // Replace "export const" with "const"
    .replace(/export\s+const\b/g, 'const ')
    // Replace "export default" with module.exports
    .replace(/export\s+default\b/g, 'module.exports =');
}

function loadTsFile(filePath, exportNames) {
  const tsCode = fs.readFileSync(filePath, 'utf8');
  const jsCode = tsToJs(tsCode);
  const wrapper = `
    (function() {
      ${jsCode}
      return { ${exportNames.join(', ')} };
    })()
  `;
  return eval(wrapper);
}

function loadSection(label, loader) {
  try {
    loader();
  } catch (err) {
    console.error(`Initialization warning (${label}):`, err.message);
  }
}

// --- Data Loading & Indexing ---
let customElements = { modules: [] };
const componentsIndex = {};
const docsIndex = {};
let keywordsData = { keywords: {}, agentKeywords: {} };
let compositionsData = { compositions: {}, agentCompositions: {} };
let rulesText = '';
let dynamicAttrs = {};
let designDocs = '';
const skillGuideDefinitions = [
  {
    id: 'create-web-components',
    file: 'create-web-components-skill.md',
    title: 'Create Web Components',
    description: 'Build framework-agnostic native Web Components using explicit APIs, shadow DOM, slots, tokens, metadata, and knowledge exports.'
  },
  {
    id: 'compose-web-components',
    file: 'compose-web-components-skill.md',
    title: 'Compose Web Components',
    description: 'Compose Muibook Web Components into complete layouts using declarative HTML, layout primitives, native slots, and parent-child context.'
  },
  {
    id: 'style-web-components',
    file: 'style-web-components-skill.md',
    title: 'Style Web Components',
    description: 'Theme Muibook components with CSS variables, semantic/component tokens, and data-theme/data-brand attributes.'
  },
  {
    id: 'create-ux-guidelines',
    file: 'create-ux-guidelines-skill.md',
    title: 'Create UX Guidelines',
    description: 'Write practical component UX guidelines for usage, accessibility, anatomy, variants, rules, behavior, writing, and compositions.'
  }
];
const skillGuides = {};

// 1. Load custom-elements.json
loadSection('custom-elements.json', () => {
  const cemPath = path.join(__dirname, 'custom-elements.json');
  if (fs.existsSync(cemPath)) {
    customElements = JSON.parse(fs.readFileSync(cemPath, 'utf8'));
    for (const mod of customElements.modules || []) {
      for (const decl of mod.declarations || []) {
        if (decl.customElement && decl.tagName) {
          componentsIndex[decl.tagName.toLowerCase()] = decl;
        }
        if (decl.kind === 'variable' && decl.name === 'muiDocs' && decl.default) {
          try {
            const docObj = eval(`(${decl.default})`);
            for (const key of Object.keys(docObj)) {
              const docKeyNormalized = key.toLowerCase().replace(/[-_ ]/g, '');
              docsIndex[docKeyNormalized] = docObj[key];
            }
          } catch (e) {
            // Ignore doc parse error
          }
        }
      }
    }
  }
});

// 2. Load keywords.ts
loadSection('keywords.ts', () => {
  const keywordsPath = path.join(__dirname, 'keywords.ts');
  if (fs.existsSync(keywordsPath)) {
    keywordsData = loadTsFile(keywordsPath, ['keywords', 'agentKeywords']);
  }
});

// 3. Load compositions.ts
loadSection('compositions.ts', () => {
  const compositionsPath = path.join(__dirname, 'compositions.ts');
  if (fs.existsSync(compositionsPath)) {
    compositionsData = loadTsFile(compositionsPath, ['compositions', 'agentCompositions']);
  }
});

// 4. Load rules.ts
loadSection('rules.ts', () => {
  const rulesPath = path.join(__dirname, 'rules.ts');
  if (fs.existsSync(rulesPath)) {
    const rulesCode = fs.readFileSync(rulesPath, 'utf8');
    const match = rulesCode.match(/String\.raw`([\s\S]*?)`/);
    rulesText = match ? match[1] : rulesCode;
  }
});

// 5. Load dynamic-attrs.json
loadSection('dynamic-attrs.json', () => {
  const attrsPath = path.join(__dirname, 'dynamic-attrs.json');
  if (fs.existsSync(attrsPath)) {
    dynamicAttrs = JSON.parse(fs.readFileSync(attrsPath, 'utf8'));
  }
});

// 6. Load DESIGN.md
loadSection('DESIGN.md', () => {
  const designPath = path.join(__dirname, 'DESIGN.md');
  if (fs.existsSync(designPath)) {
    designDocs = fs.readFileSync(designPath, 'utf8');
  }
});

// 7. Load authored skill guides
loadSection('skill guides', () => {
  for (const guide of skillGuideDefinitions) {
    const guidePath = path.join(__dirname, guide.file);
    if (fs.existsSync(guidePath)) {
      skillGuides[guide.id] = {
        ...guide,
        content: fs.readFileSync(guidePath, 'utf8')
      };
    }
  }
});

// --- Component Resolver ---
function findComponentDeclAndDoc(name) {
  const cleanName = name.toLowerCase().trim();
  const normalizedKey = cleanName.replace(/^mui-/, '').replace(/[-_ ]/g, '');

  let decl = componentsIndex[cleanName];
  if (!decl && !cleanName.startsWith('mui-')) {
    decl = componentsIndex[`mui-${cleanName}`];
  }
  if (!decl) {
    for (const [tag, value] of Object.entries(componentsIndex)) {
      if (tag.replace(/^mui-/, '').replace(/[-_ ]/g, '') === normalizedKey) {
        decl = value;
        break;
      }
    }
  }

  const doc = docsIndex[normalizedKey];
  return { decl, doc };
}

// --- Helper: Format Component API to Markdown ---
function formatComponentMarkdown(name) {
  const { decl, doc } = findComponentDeclAndDoc(name);

  if (!decl && !doc) {
    return `Component "${name}" not found in Muibook knowledge base.`;
  }

  let md = `# ${doc ? doc.title : decl.name} (\`<${decl ? decl.tagName : 'mui-' + name.toLowerCase()}>\`)\n\n`;

  if (doc && doc.description) {
    md += `${doc.description}\n\n`;
  } else if (decl && decl.description) {
    md += `${decl.description}\n\n`;
  }

  if (doc) {
    if (doc.figma || doc.storybook || doc.github || doc.website) {
      md += `**Links:** `;
      const links = [];
      if (doc.website) links.push(`[Website](${doc.website[0]})`);
      if (doc.figma) links.push(`[Figma](${doc.figma[0]})`);
      if (doc.storybook) links.push(`[Storybook](${doc.storybook[0]})`);
      if (doc.github) links.push(`[GitHub Source](${doc.github[0]})`);
      md += links.join(' | ') + '\n\n';
    }
  }

  // Attributes
  if (decl && decl.attributes && decl.attributes.length > 0) {
    md += `## Attributes\n\n`;
    md += `| Attribute | Type | Default | Description |\n`;
    md += `|-----------|------|---------|-------------|\n`;
    for (const attr of decl.attributes) {
      const typeText = attr.type ? attr.type.text : 'any';
      const defValue = attr.default !== undefined ? attr.default : '-';
      md += `| \`${attr.name}\` | \`${typeText}\` | \`${defValue}\` | ${attr.description || ''} |\n`;
    }
    md += `\n`;
  }

  // Slots
  if (decl && decl.slots && decl.slots.length > 0) {
    md += `## Slots\n\n`;
    md += `| Slot Name | Description |\n`;
    md += `|-----------|-------------|\n`;
    for (const slot of decl.slots) {
      const sName = slot.name === '' ? '*default*' : `\`${slot.name}\``;
      md += `| ${sName} | ${slot.description || ''} |\n`;
    }
    md += `\n`;
  }

  // Events
  if (decl && decl.events && decl.events.length > 0) {
    md += `## Events\n\n`;
    md += `| Event Name | Type | Description |\n`;
    md += `|------------|------|-------------|\n`;
    for (const ev of decl.events) {
      const evType = ev.type ? ev.type.text : 'CustomEvent';
      md += `| \`${ev.name}\` | \`${evType}\` | ${ev.description || ''} |\n`;
    }
    md += `\n`;
  }

  // CSS Custom Properties
  if (decl && decl.cssProperties && decl.cssProperties.length > 0) {
    md += `## CSS Custom Properties\n\n`;
    md += `| Property | Description |\n`;
    md += `|----------|-------------|\n`;
    for (const prop of decl.cssProperties) {
      md += `| \`${prop.name}\` | ${prop.description || ''} |\n`;
    }
    md += `\n`;
  }

  // CSS Parts
  if (decl && decl.cssParts && decl.cssParts.length > 0) {
    md += `## CSS Parts\n\n`;
    md += `| Part | Description |\n`;
    md += `|------|-------------|\n`;
    for (const part of decl.cssParts) {
      md += `| \`${part.name}\` | ${part.description || ''} |\n`;
    }
    md += `\n`;
  }

  // Imperative API Members
  if (decl && decl.members && decl.members.length > 0) {
    const methods = decl.members.filter(m => m.kind === 'method');
    const fields = decl.members.filter(m => m.kind === 'field');

    if (fields.length > 0) {
      md += `## JS Properties / Fields\n\n`;
      md += `| Property | Type | Description |\n`;
      md += `|----------|------|-------------|\n`;
      for (const f of fields) {
        const fType = f.type ? f.type.text : 'any';
        md += `| \`${f.name}\` | \`${fType}\` | ${f.description || ''} |\n`;
      }
      md += `\n`;
    }

    if (methods.length > 0) {
      md += `## JS Methods\n\n`;
      md += `| Method | Description |\n`;
      md += `|--------|-------------|\n`;
      for (const m of methods) {
        md += `| \`${m.name}()\` | ${m.description || ''} |\n`;
      }
      md += `\n`;
    }
  }

  // UX Usage Guidelines
  if (doc && doc.usage && doc.usage.list && doc.usage.list.length > 0) {
    md += `## Usage Guidelines\n\n`;
    for (const item of doc.usage.list) {
      md += `- ${item}\n`;
    }
    md += `\n`;
  }

  // Do's & Don'ts Rules
  if (doc && doc.rules && doc.rules.length > 0) {
    md += `## Design Rules (Do's and Don'ts)\n\n`;
    for (const r of doc.rules) {
      if (r.heading) md += `### ${r.heading}\n\n`;
      if (r.description) md += `${r.description}\n\n`;
      if (r.doContent) {
        for (const doItem of r.doContent) {
          if (doItem.description) md += `✅ **Do:** ${doItem.description}\n\n`;
        }
      }
      if (r.dontContent) {
        for (const dontItem of r.dontContent) {
          if (dontItem.description) md += `❌ **Don't:** ${dontItem.description}\n\n`;
        }
      }
    }
  }

  // Accessibility Guidelines
  if (doc && doc.accessibility) {
    const a11y = doc.accessibility;
    if ((a11y.designerList && a11y.designerList.length > 0) || (a11y.engineerList && a11y.engineerList.length > 0)) {
      md += `## Accessibility (a11y) Guidelines\n\n`;
      if (a11y.designerList && a11y.designerList.length > 0) {
        md += `### For Designers\n`;
        for (const item of a11y.designerList) {
          md += `- ${item}\n`;
        }
        md += `\n`;
      }
      if (a11y.engineerList && a11y.engineerList.length > 0) {
        md += `### For Engineers\n`;
        for (const item of a11y.engineerList) {
          md += `- ${item}\n`;
        }
        md += `\n`;
      }
    }
  }

  return md;
}

// --- JSON-RPC Message Handlers ---
function handleMessage(message, respond, respondError) {
  const { jsonrpc, id, method, params } = message;

  if (jsonrpc !== "2.0") {
    return respondError(id, -32600, "Invalid JSON-RPC request.");
  }

  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "muibook-knowledge-mcp",
          version: "1.0.0"
        }
      });

    case "notifications/initialized":
      return;

    case "ping":
      return respond(id, {});

    case "tools/list":
      return respond(id, {
        tools: [
          {
            name: "lookup_component",
            description: "Look up full API details (attributes, slots, events, CSS custom properties, JS methods) and design system UX/a11y guidelines for a specific Muibook component.",
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Component name (e.g. 'mui-button', 'Button', 'mui-drawer', 'Drawer')"
                }
              },
              required: ["name"]
            }
          },
          {
            name: "find_component",
            description: "Find matching Muibook components by searching natural-language keywords, synonyms, and functional intents.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query or functional intent (e.g. 'modal', 'avatar', 'input field', 'dropdown navigation')"
                }
              },
              required: ["query"]
            }
          },
          {
            name: "get_compositions",
            description: "Retrieve few-shot JSON component-tree examples for standard compositions (signup flow, contact form, dashboard metrics, rewards card).",
            inputSchema: {
              type: "object",
              properties: {
                onlyAgentCuration: {
                  type: "boolean",
                  description: "If true, returns only the agent-curated compositions subset. Otherwise returns all available compositions.",
                  default: false
                }
              }
            }
          },
          {
            name: "get_rules",
            description: "Get detailed rules and system guidelines for generating valid Muibook component JSON trees.",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "get_dynamic_attrs",
            description: "Retrieve runtime/destination-only attributes used dynamically by components during integration or rendering.",
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Optional component tag name (e.g. 'mui-field') to filter by."
                }
              }
            }
          },
          {
            name: "get_design_system",
            description: "Get token structures, typography specifications, spacing definitions, and layout philosophy from DESIGN.md.",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "list_skill_guides",
            description: "List authored Muibook skill guides available in this knowledge bundle.",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "get_skill_guide",
            description: "Retrieve an authored Muibook skill guide by id or filename.",
            inputSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Guide id or filename, e.g. 'create-web-components' or 'create-web-components-skill.md'."
                }
              },
              required: ["id"]
            }
          },
          {
            name: "search_skill_guides",
            description: "Search authored Muibook skill guides by title, description, filename, or content.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query, e.g. 'slots', 'tokens', 'guidelines', or 'composition'."
                }
              },
              required: ["query"]
            }
          }
        ]
      });

    case "tools/call":
      if (!params || !params.name) {
        return respondError(id, -32602, "Missing tool name parameter.");
      }
      return handleToolCall(id, params.name, params.arguments || {}, respond, respondError);

    default:
      return respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleToolCall(id, toolName, args, respond, respondError) {
  try {
    switch (toolName) {
      case "lookup_component": {
        const { name } = args;
        if (!name) {
          return respondError(id, -32602, "Parameter 'name' is required.");
        }
        const markdown = formatComponentMarkdown(name);
        return respond(id, { content: [{ type: "text", text: markdown }] });
      }

      case "find_component": {
        const { query } = args;
        if (!query) {
          return respondError(id, "Parameter 'query' is required.");
        }
        const cleanQuery = query.toLowerCase();
        const matches = [];

        const kwSource = keywordsData.keywords || {};
        for (const [compName, synonyms] of Object.entries(kwSource)) {
          const matchedSynonym = synonyms.find(syn => syn.toLowerCase().includes(cleanQuery));
          const nameMatches = compName.toLowerCase().includes(cleanQuery);
          
          if (nameMatches || matchedSynonym) {
            const tagName = `mui-${compName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}`;
            const decl = componentsIndex[tagName];
            matches.push({
              key: compName,
              tagName,
              description: decl ? decl.description : 'Muibook component',
              matchedOn: nameMatches ? 'component name' : `synonym "${matchedSynonym}"`
            });
          }
        }

        if (matches.length === 0) {
          return respond(id, { content: [{ type: "text", text: `No components matched the query "${query}".` }] });
        }

        let md = `# Search Results for "${query}"\n\n`;
        for (const m of matches) {
          md += `- **${m.key}** (\`<${m.tagName}>\`): ${m.description} *(Matched on ${m.matchedOn})*\n`;
        }
        md += `\nUse \`lookup_component\` with the tag name to retrieve full API documentation.`;
        return respond(id, { content: [{ type: "text", text: md }] });
      }

      case "get_compositions": {
        const useAgent = args.onlyAgentCuration === true;
        const comps = useAgent ? compositionsData.agentCompositions : compositionsData.compositions;
        if (!comps || Object.keys(comps).length === 0) {
          return respond(id, { content: [{ type: "text", text: "No compositions available." }] });
        }
        return respond(id, { content: [{ type: "text", text: JSON.stringify(comps, null, 2) }] });
      }

      case "get_rules": {
        if (!rulesText) {
          return respond(id, { content: [{ type: "text", text: "No generation rules available." }] });
        }
        return respond(id, { content: [{ type: "text", text: rulesText }] });
      }

      case "get_dynamic_attrs": {
        const { name } = args;
        const componentsSection = dynamicAttrs.components || {};

        if (name) {
          const cleanName = name.toLowerCase();
          const attrData = componentsSection[cleanName];
          if (!attrData) {
            return respond(id, { content: [{ type: "text", text: `No dynamic attributes documented for component "${name}".` }] });
          }
          return respond(id, { content: [{ type: "text", text: JSON.stringify({ [cleanName]: attrData }, null, 2) }] });
        }

        return respond(id, { content: [{ type: "text", text: JSON.stringify(dynamicAttrs, null, 2) }] });
      }

      case "get_design_system": {
        if (!designDocs) {
          return respond(id, { content: [{ type: "text", text: "Design system documentation not found." }] });
        }
        return respond(id, { content: [{ type: "text", text: designDocs }] });
      }

      case "list_skill_guides": {
        const guides = Object.values(skillGuides).map(({ id, file, title, description }) => ({
          id,
          file,
          title,
          description
        }));
        return respond(id, { content: [{ type: "text", text: JSON.stringify(guides, null, 2) }] });
      }

      case "get_skill_guide": {
        const { id: requestedId } = args;
        if (!requestedId) {
          return respondError(id, -32602, "Parameter 'id' is required.");
        }

        const cleanId = requestedId.toLowerCase().trim().replace(/\.md$/, '').replace(/-skill$/, '');
        const guide = skillGuides[cleanId] ||
          Object.values(skillGuides).find(item =>
            item.file.toLowerCase() === requestedId.toLowerCase().trim() ||
            item.file.toLowerCase().replace(/\.md$/, '') === requestedId.toLowerCase().trim()
          );

        if (!guide) {
          return respond(id, {
            content: [{
              type: "text",
              text: `Skill guide "${requestedId}" not found. Use list_skill_guides to see available guides.`
            }]
          });
        }

        return respond(id, { content: [{ type: "text", text: guide.content }] });
      }

      case "search_skill_guides": {
        const { query } = args;
        if (!query) {
          return respondError(id, -32602, "Parameter 'query' is required.");
        }

        const cleanQuery = query.toLowerCase();
        const matches = Object.values(skillGuides)
          .filter(guide =>
            guide.id.toLowerCase().includes(cleanQuery) ||
            guide.file.toLowerCase().includes(cleanQuery) ||
            guide.title.toLowerCase().includes(cleanQuery) ||
            guide.description.toLowerCase().includes(cleanQuery) ||
            guide.content.toLowerCase().includes(cleanQuery)
          )
          .map(({ id, file, title, description }) => ({ id, file, title, description }));

        if (matches.length === 0) {
          return respond(id, { content: [{ type: "text", text: `No skill guides matched "${query}".` }] });
        }

        return respond(id, { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] });
      }

      default:
        return respondError(id, -32601, `Unknown tool: ${toolName}`);
    }
  } catch (err) {
    return respondError(id, -32603, `Internal error executing tool: ${err.message}`);
  }
}

// --- Transport Selection ---
const args = process.argv.slice(2);
const sseMode = args.includes('--sse') || args.some(arg => arg.startsWith('--port'));
let port = 22222;

const portArgIndex = args.findIndex(arg => arg === '--port' || arg === '-p');
if (portArgIndex !== -1 && args[portArgIndex + 1]) {
  port = parseInt(args[portArgIndex + 1], 10);
} else {
  const portMatch = args.find(arg => arg.startsWith('--port='));
  if (portMatch) {
    port = parseInt(portMatch.split('=')[1], 10);
  }
}

if (sseMode) {
  // --- Run over HTTP Server-Sent Events (SSE) ---
  const sessions = new Map();

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);

    // Logging to help troubleshoot connections
    console.error(`[MCP SSE] Received ${req.method} request for ${req.url}`);

    if (req.method === 'GET' && parsedUrl.pathname === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const sessionId = Math.random().toString(36).substring(2, 15);
      sessions.set(sessionId, res);

      // Construct absolute URL dynamically using request host header to avoid resolution bugs in client
      const host = req.headers.host || `localhost:${port}`;
      const scheme = req.socket.encrypted ? 'https' : 'http';
      const endpointUrl = `${scheme}://${host}/message?session=${sessionId}`;

      console.error(`[MCP SSE] New session ${sessionId} connected. Directing POST messages to: ${endpointUrl}`);
      res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

      req.on('close', () => {
        console.error(`[MCP SSE] Session ${sessionId} closed.`);
        sessions.delete(sessionId);
      });
      return;
    }

    // Support both /message and /sse for POST requests, using either query name 'session' or 'sessionId'
    if (req.method === 'POST' && (parsedUrl.pathname === '/message' || parsedUrl.pathname === '/sse')) {
      const sessionId = parsedUrl.query.session || parsedUrl.query.sessionId;
      console.error(`[MCP SSE] Processing message POST for session: ${sessionId}`);

      const sseRes = sessions.get(sessionId);
      if (!sseRes && sessionId) {
        console.error(`[MCP SSE] WARNING: No active SSE session found for session ID: ${sessionId}`);
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });

      req.on('end', () => {
        try {
          const message = JSON.parse(body);
          console.error(`[MCP SSE] Incoming RPC: ${message.method} (ID: ${message.id})`);

          let responded = false;
          const respond = (id, result) => {
            responded = true;
            const resp = JSON.stringify({ jsonrpc: "2.0", id, result });
            if (sseRes) {
              console.error(`[MCP SSE] Sending response via SSE for message ID: ${id}`);
              sseRes.write(`event: message\ndata: ${resp}\n\n`);
            } else {
              console.error(`[MCP SSE] Sending response directly via HTTP POST for message ID: ${id}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(resp);
            }
          };

          const respondError = (id, code, errMsg) => {
            responded = true;
            const resp = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: errMsg } });
            if (sseRes) {
              console.error(`[MCP SSE] Sending error via SSE for message ID: ${id}`);
              sseRes.write(`event: message\ndata: ${resp}\n\n`);
            } else {
              console.error(`[MCP SSE] Sending error directly via HTTP POST for message ID: ${id}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(resp);
            }
          };

          handleMessage(message, respond, respondError);

          // If we responded via SSE, resolve the POST request immediately with 202 Accepted
          if (sseRes) {
            res.writeHead(202, { 'Content-Type': 'text/plain' });
            res.end('Accepted');
          } else if (!responded) {
            // For direct HTTP JSON-RPC notifications (no ID, so respond/respondError are not called)
            console.error(`[MCP SSE] Direct POST notification processed (no response required). Acknowledging with 204.`);
            res.writeHead(204, { 'Content-Type': 'text/plain' });
            res.end();
          }
        } catch (err) {
          console.error(`[MCP SSE] Error parsing message body: ${err.message}`);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    console.error(`[MCP SSE] Route not found (404): ${req.method} ${parsedUrl.pathname}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.error(`Muibook MCP SSE Server running on http://localhost:${port}`);
    console.error(`SSE Endpoint: http://localhost:${port}/sse`);
  });

} else {
  // --- Run over Stdio ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const respond = (id, result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };

  const respondError = (id, code, errMsg) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: errMsg } }) + "\n");
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      handleMessage(message, respond, respondError);
    } catch (err) {
      respondError(null, -32700, "Parse error: " + err.message);
    }
  });
}
