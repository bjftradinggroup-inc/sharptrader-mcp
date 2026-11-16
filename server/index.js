#!/usr/bin/env node
'use strict';

// SharpTrader for Claude Desktop (MCP Bundle). Claude Desktop starts this file with its own Node.js and speaks MCP over
// stdin/stdout, one JSON-RPC message per line; every message goes to SharpTrader's MCP server (Streamable HTTP,
// Settings > AI agents (MCP)) and its answer comes back. Node's own http/https only - nothing to install.
//
// When SharpTrader cannot be reached at the start (it usually starts after Claude), the bridge answers initialize
// itself and lists SharpTrader's tools from tools.json (they answer why they cannot run yet) and one more,
// connection_status, that explains why; it keeps trying and, once SharpTrader answers, tells Claude to load
// SharpTrader's own list (notifications/tools/list_changed). A refused token or certificate is not retried.
// A catalog that only starts this file (no SharpTrader, no token) gets the same answers, so it sees the tools.
// Diagnostics go to stderr, which Claude Desktop keeps in its MCP log; the token is never written anywhere.

const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const path = require('path');
const readline = require('readline');

const BRIDGE_VERSION = '1.1.0';
const DEFAULT_URL = 'http://127.0.0.1:47350/mcp';
const REQUEST_TIMEOUT_MS = 180000;  // a SharpTrader tool may wait 30 s for its window, refresh_news 60 s for the download
const RETRY_MS = 15000;
const STATUS_TOOL = 'connection_status';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function log(text) {
  process.stderr.write(`[sharptrader] ${text}\n`);
}

/** A setting from the extension's configuration; an optional one Claude Desktop left unsubstituted counts as empty. */
function setting(name) {
  const value = (process.env[name] || '').trim();
  return value.startsWith('${') ? '' : value;
}

//---- configuration ----

let configProblem = '';
let endpoint = null;
let agent = null;
const token = setting('SHARPTRADER_TOKEN').replace(/^bearer\s+/i, '');
const certificatePath = setting('SHARPTRADER_CERTIFICATE');

/** The certificates of a .cer/.pem/.crt file, PEM or DER (as Windows exports it). */
function readCertificates(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pfx' || extension === '.p12')
    throw new Error(`Choose the .cer file in the extension settings, not ${path.basename(file)}: a .pfx holds the server's private key - do not copy it to other computers.`);

  let data;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    throw new Error(`The certificate file ${file} cannot be read (${e.code || e.message}). Choose the .cer file again in the extension settings.`);
  }

  const text = data.toString('latin1');
  const pem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pem)
    return pem;
  if (data.length > 0 && data[0] === 0x30) {
    const base64 = data.toString('base64').replace(/.{1,64}/g, '$&\n');
    return [`-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n`];
  }
  throw new Error(`${file} is not a certificate file. Choose the .cer file SharpTrader created next to the .pfx.`);
}

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * HTTPS with the certificate file: a server is trusted when its chain checks out against the file (a CA), or when it
 * shows exactly a certificate of the file. SharpTrader's self-signed certificates have no certificate-signing key usage,
 * so some TLS libraries (BoringSSL in Electron's Node) refuse them as their own trust anchor - the exact copy is the
 * stronger check anyway, and it does not depend on the address being in the certificate. The socket reaches the HTTP
 * client, which sends the token, only after this check.
 */
class PinningAgent extends https.Agent {
  constructor(options, pinned) {
    super(options);
    this.pinned = pinned;
  }

  createConnection(options, callback) {
    let done = false;
    const finish = (error, socket) => {
      if (!done) {
        done = true;
        callback(error, socket);
      }
    };
    const socket = tls.connect(Object.assign({}, options, { rejectUnauthorized: false }));
    socket.once('secureConnect', () => {
      const error = this.trustError(socket);
      if (error) {
        socket.destroy();
        finish(error);
      } else {
        finish(null, socket);
      }
    });
    socket.once('error', e => finish(e));
  }

  trustError(socket) {
    if (socket.authorized)
      return null;
    const peer = socket.getPeerCertificate();
    if (peer && peer.raw && this.pinned.some(p => p.equals(peer.raw))) {
      if (Date.now() > Date.parse(peer.valid_to))
        return codeError('CERT_HAS_EXPIRED');
      if (Date.now() < Date.parse(peer.valid_from))
        return codeError('CERT_NOT_YET_VALID');
      return null;
    }
    return codeError(String(socket.authorizationError || 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
  }
}

try {
  //no address: SharpTrader on this computer, at its default port
  let address = setting('SHARPTRADER_URL') || DEFAULT_URL;
  if (!/^[a-z]+:\/\//i.test(address)) {
    //without a scheme: plain HTTP serves only this computer, every other address needs HTTPS
    const host = address.split(/[:/]/)[0].replace(/^\[|\]$/g, '').toLowerCase();
    address = (host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'http://' : 'https://') + address;
  }
  endpoint = new URL(address);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new Error(`The SharpTrader address must start with http:// or https:// (${address}).`);
  if (endpoint.pathname === '/' || endpoint.pathname === '')
    endpoint.pathname = '/mcp';
  if (!token)
    throw new Error('The access token is empty. Press Copy next to the token in SharpTrader (Settings › AI agents (MCP)) and paste it into the extension settings.');

  if (endpoint.protocol === 'https:') {
    if (certificatePath) {
      const pem = readCertificates(certificatePath);
      const pinned = pem.map(p => Buffer.from(p.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'));
      agent = new PinningAgent({ keepAlive: true, ca: tls.rootCertificates.concat(pem) }, pinned);
    } else {
      agent = new https.Agent({ keepAlive: true });
    }
  } else {
    agent = new http.Agent({ keepAlive: true });
  }
  log(`SharpTrader at ${endpoint.href}${certificatePath ? `, certificate ${certificatePath}` : ''}`);
} catch (e) {
  configProblem = e.message;
  log(configProblem);
}

//---- talking to SharpTrader ----

let protocolVersion = '';
let sessionId = '';

/**
 * One POST to SharpTrader; resolves with the status, content type and body. A kept-alive connection that SharpTrader
 * closed meanwhile (a restart) fails at once on reuse: that request is sent once more on a new connection.
 */
function post(body) {
  return postOnce(body).catch(error => {
    if (error.reusedSocket && (error.code === 'ECONNRESET' || error.code === 'EPIPE'))
      return postOnce(body);
    throw error;
  });
}

function postOnce(body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + token,
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': `SharpTrader-Claude-Extension/${BRIDGE_VERSION}`
    };
    if (protocolVersion)
      headers['MCP-Protocol-Version'] = protocolVersion;
    if (sessionId)
      headers['Mcp-Session-Id'] = sessionId;

    const library = endpoint.protocol === 'https:' ? https : http;
    const request = library.request(endpoint, { method: 'POST', headers, agent, timeout: REQUEST_TIMEOUT_MS }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        if (response.headers['mcp-session-id'])
          sessionId = String(response.headers['mcp-session-id']);
        resolve({
          status: response.statusCode,
          type: String(response.headers['content-type'] || ''),
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })));
    request.on('error', error => reject(Object.assign(error, { reusedSocket: request.reusedSocket })));
    request.end(body);
  });
}

/** The JSON-RPC messages of a 200 answer: a JSON body, or the data of each server-sent event. */
function messagesOf(answer) {
  if (answer.type.includes('text/event-stream')) {
    const messages = [];
    for (const event of answer.text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data.trim())
        messages.push(JSON.parse(data));
    }
    return messages;
  }
  return answer.text.trim() ? [JSON.parse(answer.text)] : [];
}

/** What a failed connection means for the user, in SharpTrader's terms. */
function networkProblem(error) {
  const where = endpoint.host;
  switch (error.code) {
    case 'ECONNREFUSED':
      return `SharpTrader does not answer at ${where}. Start SharpTrader and switch its AI agents server on (Settings › AI agents (MCP)), then check the address and port in the extension settings.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The address ${endpoint.hostname} cannot be found. Check the SharpTrader address in the extension settings.`;
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EPIPE':
      return `No answer from ${where}. Check that SharpTrader runs with its AI agents server on, that the port is open in the Windows Firewall of that computer, and that the address starts with https:// when SharpTrader uses a certificate.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'CERT_UNTRUSTED':
      return certificatePath
        ? `SharpTrader's certificate is not the one in ${certificatePath}. Choose the .cer file of the certificate SharpTrader uses now in the extension settings.`
        : 'SharpTrader uses a self-signed certificate. Choose its .cer file (SharpTrader created it next to the .pfx) in the extension settings.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `SharpTrader's certificate is not made for ${endpoint.hostname}. Use an address the certificate has, or create the certificate again in SharpTrader with this address.`;
    case 'CERT_HAS_EXPIRED':
      return 'SharpTrader\'s certificate has expired. Create a new one in SharpTrader (Settings › AI agents (MCP)) and choose its .cer file here.';
    case 'CERT_NOT_YET_VALID':
      return 'SharpTrader\'s certificate is not valid yet - check the clock of both computers.';
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return `${where} does not answer HTTPS. Use http:// for 127.0.0.1, or give SharpTrader a certificate for network addresses.`;
    default:
      return `Cannot reach SharpTrader at ${where}: ${error.message}`;
  }
}

/** Network trouble may pass (SharpTrader not started yet); a refused certificate does not. */
function retryable(error) {
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(error.code);
}

function statusProblem(answer) {
  const text = answer.text.trim().slice(0, 300);
  switch (answer.status) {
    case 401:
      return 'SharpTrader refused the access token. Press Copy next to the token in SharpTrader (Settings › AI agents (MCP)) and paste it into the extension settings - "New token" there replaces the old one.';
    case 429:
      return 'SharpTrader blocks this computer for 15 minutes after too many wrong access tokens. Correct the token in the extension settings and try again later.';
    case 403:
      return `SharpTrader refused the request (403)${text ? ': ' + text : ''}.`;
    case 404:
      return `Nothing answers at ${endpoint.href}: the address must end with /mcp.`;
    case 413:
      return 'The request is too large for SharpTrader.';
    default:
      return `SharpTrader answered ${answer.status}${text ? ': ' + text : ''}.`;
  }
}

//---- the stdio side ----

/** ok: SharpTrader answers; offline: not reachable, retried; refused: token or certificate refused, not retried. */
let state = 'ok';
let problem = '';
let initializeMessage = null;
let localToolsShown = false;
let retryTimer = null;
let pending = 0;
let inputClosed = false;
let lastLogged = '';

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function logOnce(text) {
  if (text !== lastLogged)
    log(text);
  lastLogged = text;
}

const isRequest = m => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null;

function localInitialize(message) {
  const asked = message.params && message.params.protocolVersion;
  write({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'SharpTrader', version: `extension ${BRIDGE_VERSION}` },
      instructions: `SharpTrader is not connected: ${configProblem || problem} Its tools are listed but cannot run until it is. The tool ${STATUS_TOOL} tries again.`
    }
  });
}

/**
 * SharpTrader's tools as its server lists them (tools.json next to this file, generated from SharpTrader's own tool
 * definitions), shown while SharpTrader cannot be reached. Once it answers, its own list replaces them: the tools the
 * user allowed there, which may be more or fewer.
 */
function builtInTools() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools.json'), 'utf8').replace(/^﻿/, '')).tools;
    if (Array.isArray(list))
      return list.filter(t => t && typeof t === 'object' && typeof t.name === 'string' && t.name !== STATUS_TOOL);
    log('tools.json has no tool list');
  } catch (e) {
    log(`tools.json cannot be read (${e.code || e.message})`);
  }
  return [];
}

const BUILT_IN_TOOLS = builtInTools();

function localToolList(message) {
  localToolsShown = true;
  write({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      tools: [{
        name: STATUS_TOOL,
        title: 'SharpTrader connection',
        description: `SharpTrader is not connected, so its tools cannot run yet: ${configProblem || problem} Call this tool to try again after fixing it.`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false }
      }].concat(BUILT_IN_TOOLS)
    }
  });
}

function setProblem(next, nextState) {
  problem = next;
  state = nextState;
  logOnce(next);
  if (state === 'offline' && !retryTimer) {
    retryTimer = setInterval(() => { if (state === 'offline') probe().catch(() => {}); }, RETRY_MS);
    retryTimer.unref();
  }
}

function online() {
  if (state === 'ok')
    return;
  state = 'ok';
  problem = '';
  lastLogged = '';
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  log('connected to SharpTrader');
  //Claude got the stand-in tool list: let it load SharpTrader's tools
  if (localToolsShown)
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

/** Asks SharpTrader again (initialize, as Claude sent it); true when it answers. */
async function probe() {
  const message = initializeMessage || {
    jsonrpc: '2.0', id: 'probe', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sharptrader-extension', version: BRIDGE_VERSION } }
  };
  try {
    const answer = await post(JSON.stringify({ ...message, id: `probe-${Date.now()}` }));
    if (answer.status === 200) {
      const result = messagesOf(answer)[0];
      if (result && result.result && result.result.protocolVersion)
        protocolVersion = result.result.protocolVersion;
      online();
      return true;
    }
    setProblem(statusProblem(answer), answer.status === 401 || answer.status === 429 || answer.status === 403 ? 'refused' : 'offline');
  } catch (e) {
    setProblem(networkProblem(e), retryable(e) ? 'offline' : 'refused');
  }
  return false;
}

async function statusCall(message) {
  const connected = configProblem ? false : await probe();
  const text = connected
    ? 'Connected to SharpTrader again; its tools are being loaded. If they do not appear, turn the SharpTrader extension off and on in Claude\'s settings.'
    : `SharpTrader is still not connected: ${configProblem || problem}`;
  write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], isError: !connected } });
}

/** A message SharpTrader did not take: stand-ins for the start-up messages, an error for any other request. */
function failed(message, method) {
  if (method === 'initialize')
    return localInitialize(message);
  if (method === 'tools/list')
    return localToolList(message);
  if (method === 'ping')
    return write({ jsonrpc: '2.0', id: message.id, result: {} });

  const requests = (Array.isArray(message) ? message : [message]).filter(isRequest);
  const errors = requests.map(m => ({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: configProblem || problem } }));
  if (errors.length)
    write(Array.isArray(message) ? errors : errors[0]);
}

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    log(`not JSON from Claude: ${line.slice(0, 200)}`);
    return;
  }

  const method = !Array.isArray(message) && message ? message.method : undefined;
  if (method === 'initialize')
    initializeMessage = message;

  if (configProblem)
    return method === 'tools/call' && message.params && message.params.name === STATUS_TOOL ? statusCall(message) : failed(message, method);
  if (method === 'tools/call' && message.params && message.params.name === STATUS_TOOL)
    return statusCall(message);

  let answer;
  try {
    answer = await post(JSON.stringify(message));
  } catch (e) {
    //only the start-up messages decide the state: Claude keeps the tools it has, a call just fails
    if (method === 'initialize' || method === 'tools/list' || state !== 'ok')
      setProblem(networkProblem(e), retryable(e) ? 'offline' : 'refused');
    else {
      problem = networkProblem(e);
      logOnce(problem);
    }
    return failed(message, method);
  }

  if (answer.status === 200) {
    let replies;
    try {
      replies = messagesOf(answer);
    } catch (e) {
      problem = 'SharpTrader\'s answer could not be read.';
      log(`${problem} ${e.message}`);
      return failed(message, method);
    }
    for (const reply of replies) {
      if (method === 'initialize' && reply.result && reply.result.protocolVersion)
        protocolVersion = reply.result.protocolVersion;
      write(reply);
    }
    online();
    return;
  }
  if (answer.status === 202 || answer.status === 204)
    return online();

  const refused = answer.status === 401 || answer.status === 429 || answer.status === 403;
  if (method === 'initialize' || method === 'tools/list' || state !== 'ok')
    setProblem(statusProblem(answer), refused ? 'refused' : 'offline');
  else {
    problem = statusProblem(answer);
    logOnce(problem);
  }
  failed(message, method);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim())
    return;
  pending++;
  handle(line.trim())
    .catch(e => log(`unexpected: ${e && e.stack || e}`))
    .finally(() => {
      pending--;
      if (inputClosed && pending === 0)
        process.exit(0);
    });
});
input.on('close', () => {
  inputClosed = true;
  if (pending === 0)
    process.exit(0);
});
