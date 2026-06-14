#!/usr/bin/env node

/**
 * Muibook Model Context Protocol (MCP) Server
 * 
 * Exposes the structured knowledge of the Muibook component library to AI assistants
 * (Antigravity, OpenCode, GPT, Codex, Claude Code, Claude Desktop, etc.).
 * 
 * Written in pure, dependency-free Node.js for maximum speed, compatibility, and simplicity.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Helper: TypeScript to JavaScript converter ---
function tsToJs(tsCode) {
  return tsCode
    // Remove Pick typecast
    .replace(/\s+as\s+Pick<[^>]+>/g, '')
    // Remove type annotations on variables (e.g., ": Record<string, string[]>")
    .replace(/:\s*Record<[^>]+>/g, '')
    // Remove "as const"
    .replace(/\s+as\s+const\b/g, '')
    // Remove type declarations (e.g., "export type AgentKeywordKey = ...")
    .replace(/export\s+type\s+\w+\s*=\s*[^;]+;/g, '')
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

// --- Data Loading & Indexing ---
let customElements = { modules: [] };
const componentsIndex = {};
const docsIndex = {};
let keywordsData = { keywords: {}, agentKeywords: {} };
let compositionsData = { compositions: {}, agentCompositions: {} };
let rulesText = '';
let dynamicAttrs = {};
let designDocs = '';

try {
  // 1. Load custom-elements.json
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

  // 2. Load keywords.ts
  const keywordsPath = path.join(__dirname, 'keywords.ts');
  if (fs.existsSync(keywordsPath)) {
    keywordsData = loadTsFile(keywordsPath, ['keywords', 'agentKeywords']);
  }

  // 3. Load compositions.ts
  const compositionsPath = path.join(__dirname, 'compositions.ts');
  if (fs.existsSync(compositionsPath)) {
    compositionsData = loadTsFile(compositionsPath, ['compositions', 'agentCompositions']);
  }

  // 4. Load rules.ts
  const rulesPath = path.join(__dirname, 'rules.ts');
  if (fs.existsSync(rulesPath)) {
    const rulesCode = fs.readFileSync(rulesPath, 'utf8');
    const match = rulesCode.match(/String\.raw`([\s\S]*?)`/);
    rulesText = match ? match[1] : rulesCode;
  }

  // 5. Load dynamic-attrs.json
  const attrsPath = path.join(__dirname, 'dynamic-attrs.json');
  if (fs.existsSync(attrsPath)) {
    dynamicAttrs = JSON.parse(fs.readFileSync(attrsPath, 'utf8'));
  }

  // 6. Load DESIGN.md
  const designPath = path.join(__dirname, 'DESIGN.md');
  if (fs.existsSync(designPath)) {
    designDocs = fs.readFileSync(designPath, 'utf8');
  }

} catch (err) {
  console.error("Initialization warning:", err.message);
}

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
function handleMessage(message) {
  const { jsonrpc, id, method, params } = message;

  if (jsonrpc !== "2.0") {
    return sendError(id, -32600, "Invalid JSON-RPC request.");
  }

  switch (method) {
    case "initialize":
      return sendResponse(id, {
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
      return sendResponse(id, {});

    case "tools/list":
      return sendResponse(id, {
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
          }
        ]
      });

    case "tools/call":
      if (!params || !params.name) {
        return sendError(id, -32602, "Missing tool name parameter.");
      }
      return handleToolCall(id, params.name, params.arguments || {});

    default:
      return sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleToolCall(id, toolName, args) {
  try {
    switch (toolName) {
      case "lookup_component": {
        const { name } = args;
        if (!name) {
          return sendToolError(id, "Parameter 'name' is required.");
        }
        const markdown = formatComponentMarkdown(name);
        return sendToolResult(id, markdown);
      }

      case "find_component": {
        const { query } = args;
        if (!query) {
          return sendToolError(id, "Parameter 'query' is required.");
        }
        const cleanQuery = query.toLowerCase();
        const matches = [];

        // Search in keywords record
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
          return sendToolResult(id, `No components matched the query "${query}".`);
        }

        let md = `# Search Results for "${query}"\n\n`;
        for (const m of matches) {
          md += `- **${m.key}** (\`<${m.tagName}>\`): ${m.description} *(Matched on ${m.matchedOn})*\n`;
        }
        md += `\nUse \`lookup_component\` with the tag name to retrieve full API documentation.`;
        return sendToolResult(id, md);
      }

      case "get_compositions": {
        const useAgent = args.onlyAgentCuration === true;
        const comps = useAgent ? compositionsData.agentCompositions : compositionsData.compositions;
        if (!comps || Object.keys(comps).length === 0) {
          return sendToolResult(id, "No compositions available.");
        }
        return sendToolResult(id, JSON.stringify(comps, null, 2), "json");
      }

      case "get_rules": {
        if (!rulesText) {
          return sendToolResult(id, "No generation rules available.");
        }
        return sendToolResult(id, rulesText);
      }

      case "get_dynamic_attrs": {
        const { name } = args;
        const componentsSection = dynamicAttrs.components || {};

        if (name) {
          const cleanName = name.toLowerCase();
          const attrData = componentsSection[cleanName];
          if (!attrData) {
            return sendToolResult(id, `No dynamic attributes documented for component "${name}".`);
          }
          return sendToolResult(id, JSON.stringify({ [cleanName]: attrData }, null, 2), "json");
        }

        return sendToolResult(id, JSON.stringify(dynamicAttrs, null, 2), "json");
      }

      case "get_design_system": {
        if (!designDocs) {
          return sendToolResult(id, "Design system documentation not found.");
        }
        return sendToolResult(id, designDocs);
      }

      default:
        return sendError(id, -32601, `Unknown tool: ${toolName}`);
    }
  } catch (err) {
    return sendError(id, -32603, `Internal error executing tool: ${err.message}`);
  }
}

// --- Response Helpers ---
function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result
  }) + "\n");
}

function sendError(id, code, message, data) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data
    }
  }) + "\n");
}

function sendToolResult(id, text, format = "text") {
  sendResponse(id, {
    content: [
      {
        type: "text",
        text: text
      }
    ]
  });
}

function sendToolError(id, errorMessage) {
  sendResponse(id, {
    content: [
      {
        type: "text",
        text: `Error: ${errorMessage}`
      }
    ],
    isError: true
  });
}

// --- Main Interface ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    handleMessage(message);
  } catch (err) {
    sendError(null, -32700, "Parse error: " + err.message);
  }
});
