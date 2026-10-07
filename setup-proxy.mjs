// Parses PROXY_URL (vless://, vmess://, trojan://, hysteria2://, hy2://, tuic://)
// and generates a sing-box config with a local mixed inbound (socks5+http on 127.0.0.1:1080).
// Usage: PROXY_URL="vless://..." node setup-proxy.mjs > sb-config.json

function parseVmess(link) {
  const b64 = link.replace('vmess://', '');
  // pad base64 if needed (handle base64url too)
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  let j;
  try {
    j = JSON.parse(decoded);
  } catch {
    // fallback: "security:uuid@host:port" or "uuid@host:port" plain format
    // aggressively strip invisible chars (zero-width spaces, BOM, control chars, fancy hyphens)
    let clean = decoded
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .trim();
    // match at start only; ignore any trailing garbage after the port
    const m = clean.match(/^(?:(\w+):)?([^@\s]+)@([^:\s]+):(\d+)/);
    if (!m) throw new Error('unrecognized vmess payload: ' + clean.slice(0, 60));
    const [, sec, uuid, host, port] = m;
    j = { add: host, port, id: uuid, aid: '0', scy: sec && sec !== 'none' ? sec : 'auto', net: 'tcp', tls: parseInt(port) === 443 ? 'tls' : '' };
  }
  const ob = { type: 'vmess', server: j.add, server_port: parseInt(j.port), uuid: j.id, security: j.scy || 'auto', alter_id: parseInt(j.aid || '0') };
  applyTransport(ob, j);
  return ob;
}

function applyTransport(ob, j) {
  const net = j.net || 'tcp';
  if (net === 'ws') {
    ob.transport = { type: 'ws', path: j.path || '/', headers: j.host ? { Host: j.host } : {} };
    if (j.tls === 'tls') { ob.tls = { enabled: true, server_name: j.sni || j.host || j.add, insecure: false }; }
  } else if (net === 'grpc') {
    ob.transport = { type: 'grpc', service_name: j.path || '' };
    if (j.tls === 'tls') { ob.tls = { enabled: true, server_name: j.sni || j.add }; }
  } else if (net === 'tcp') {
    if (j.type === 'http') {
      ob.transport = { type: 'http', host: j.host ? [j.host] : [], path: j.path || '/' };
    }
    if (j.tls === 'tls') { ob.tls = { enabled: true, server_name: j.sni || j.add }; }
  }
  if (j.fp) { ob.tls = ob.tls || { enabled: true, server_name: j.sni || j.add }; ob.tls.utls = { enabled: true, fingerprint: j.fp }; }
}

function parseXrayLink(link) {
  // vless://, trojan://, hysteria2://, hy2://, tuic://
  const u = new URL(link);
  const proto = u.protocol.replace(':', '');
  const params = Object.fromEntries(u.searchParams.entries());
  const server = u.hostname;
  const port = parseInt(u.port);
  const security = params.security || '';

  if (proto === 'vless') {
    const ob = { type: 'vless', server, server_port: port, uuid: decodeURIComponent(u.username), flow: params.flow || undefined };
    const net = params.type || 'tcp';
    if (net === 'ws') {
      ob.transport = { type: 'ws', path: params.path || '/', headers: params.host ? { Host: params.host } : {} };
    } else if (net === 'grpc') {
      ob.transport = { type: 'grpc', service_name: params.serviceName || '' };
    }
    if (security === 'tls') {
      ob.tls = { enabled: true, server_name: params.sni || server };
      if (params.fp) ob.tls.utls = { enabled: true, fingerprint: params.fp };
      if (params.alpn) ob.tls.alpn = params.alpn.split(',');
    } else if (security === 'reality') {
      ob.tls = {
        enabled: true, server_name: params.sni || server,
        reality: { enabled: true, public_key: params.pbk || '', short_id: params.sid || '' },
      };
      if (params.fp) ob.tls.utls = { enabled: true, fingerprint: params.fp };
    }
    return ob;
  }
  if (proto === 'trojan') {
    const ob = { type: 'trojan', server, server_port: port, password: decodeURIComponent(u.username) };
    const net = params.type || 'tcp';
    if (net === 'ws') ob.transport = { type: 'ws', path: params.path || '/', headers: params.host ? { Host: params.host } : {} };
    ob.tls = { enabled: true, server_name: params.sni || server };
    if (params.fp) ob.tls.utls = { enabled: true, fingerprint: params.fp };
    return ob;
  }
  if (proto === 'hysteria2' || proto === 'hy2') {
    const ob = { type: 'hysteria2', server, server_port: port, password: decodeURIComponent(u.username) || params.auth || '' };
    ob.tls = { enabled: true, server_name: params.sni || server };
    if (params.insecure === '1') ob.tls.insecure = true;
    if (params.obfs) ob.obfs = { type: params.obfs, password: params['obfs-password'] || '' };
    return ob;
  }
  if (proto === 'tuic') {
    const [uuid, password] = decodeURIComponent(u.username).split(':');
    const ob = { type: 'tuic', server, server_port: port, uuid, password: password || uuid };
    ob.tls = { enabled: true, server_name: params.sni || server };
    if (params.alpn) ob.tls.alpn = params.alpn.split(',');
    ob.congestion_control = params.congestion_control || 'bbr';
    return ob;
  }
  throw new Error('unsupported protocol: ' + proto);
}

const raw = (process.env.PROXY_URL || '').trim();
if (!raw) { console.error('PROXY_URL not set'); process.exit(1); }

let outbound;
if (raw.startsWith('vmess://')) outbound = parseVmess(raw);
else outbound = parseXrayLink(raw);
// strip undefined
outbound = JSON.parse(JSON.stringify(outbound));
outbound.tag = 'proxy';

const config = {
  log: { level: 'warn' },
  inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 1080 }],
  outbounds: [outbound, { type: 'direct', tag: 'direct' }],
};
console.log(JSON.stringify(config, null, 2));
