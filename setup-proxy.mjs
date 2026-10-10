import fs from 'fs';

const rawUrl = (process.env.PROXY_URL || '').trim();

if (!rawUrl) {
  console.error('[proxy-setup] PROXY_URL is empty');
  process.exit(1);
}

function parseProxy(link) {
  const protocol = link.split('://')[0].toLowerCase();

  // 1. VLESS (支持 Reality, TLS, WebSocket, gRPC)
  if (protocol === 'vless') {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams);
    const outbound = {
      type: 'vless',
      tag: 'proxy',
      server: url.hostname,
      server_port: parseInt(url.port, 10),
      uuid: url.username,
      flow: params.flow || undefined,
    };

    if (params.security === 'reality') {
      outbound.tls = {
        enabled: true,
        server_name: params.sni || url.hostname,
        reality: {
          enabled: true,
          public_key: params.pbk || '',
          short_id: params.sid || '',
        },
      };
      if (params.fp) outbound.tls.utls = { enabled: true, fingerprint: params.fp };
    } else if (params.security === 'tls') {
      outbound.tls = {
        enabled: true,
        server_name: params.sni || url.hostname,
        insecure: params.allowInsecure === '1',
      };
      if (params.fp) outbound.tls.utls = { enabled: true, fingerprint: params.fp };
    }

    if (params.type === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: params.path || '/',
        headers: params.host ? { Host: params.host } : undefined,
      };
    } else if (params.type === 'grpc') {
      outbound.transport = {
        type: 'grpc',
        service_name: params.serviceName || '',
      };
    }
    return outbound;
  }

  // 2. VMESS (Base64 JSON)
  if (protocol === 'vmess') {
    const b64 = link.replace('vmess://', '');
    const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
    const v = JSON.parse(jsonStr);

    const outbound = {
      type: 'vmess',
      tag: 'proxy',
      server: v.add,
      server_port: parseInt(v.port, 10),
      uuid: v.id,
      security: v.scy || 'auto',
      alter_id: parseInt(v.aid || 0, 10),
    };

    if (v.tls === 'tls') {
      outbound.tls = {
        enabled: true,
        server_name: v.sni || v.host || v.add,
      };
    }

    if (v.net === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: v.path || '/',
        headers: v.host ? { Host: v.host } : undefined,
      };
    }
    return outbound;
  }

  // 3. HYSTERIA 2
  if (protocol === 'hysteria2' || protocol === 'hy2') {
    const normalized = link.replace(/^hy2:\/\//, 'hysteria2://');
    const url = new URL(normalized);
    const params = Object.fromEntries(url.searchParams);
    const outbound = {
      type: 'hysteria2',
      tag: 'proxy',
      server: url.hostname,
      server_port: parseInt(url.port, 10),
      password: url.username || url.password,
      tls: {
        enabled: true,
        server_name: params.sni || url.hostname,
        insecure: params.insecure === '1',
      },
    };
    if (params.obfs && params.obfs !== 'none') {
      outbound.obfs = {
        type: params.obfs,
        password: params['obfs-password'] || '',
      };
    }
    return outbound;
  }

  // 4. TROJAN
  if (protocol === 'trojan') {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams);
    const outbound = {
      type: 'trojan',
      tag: 'proxy',
      server: url.hostname,
      server_port: parseInt(url.port, 10),
      password: url.username,
      tls: {
        enabled: true,
        server_name: params.sni || url.hostname,
        insecure: params.allowInsecure === '1',
      },
    };
    if (params.type === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: params.path || '/',
        headers: params.host ? { Host: params.host } : undefined,
      };
    }
    return outbound;
  }

  // 5. SHADOWSOCKS
  if (protocol === 'ss') {
    const clean = link.replace('ss://', '').split('#')[0];
    let method, password, server, port;
    if (clean.includes('@')) {
      const [userinfo, serverinfo] = clean.split('@');
      const decoded = Buffer.from(userinfo, 'base64').toString('utf-8');
      [method, password] = decoded.split(':');
      [server, port] = serverinfo.split(':');
    } else {
      const decoded = Buffer.from(clean, 'base64').toString('utf-8');
      const [userinfo, serverinfo] = decoded.split('@');
      [method, password] = userinfo.split(':');
      [server, port] = serverinfo.split(':');
    }
    return {
      type: 'shadowsocks',
      tag: 'proxy',
      server,
      server_port: parseInt(port, 10),
      method,
      password,
    };
  }

  // 6. ANYTLS
  if (protocol === 'anytls') {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams);
    const outbound = {
      type: 'anytls',
      tag: 'proxy',
      server: url.hostname,
      server_port: parseInt(url.port, 10),
      password: url.username,
      tls: {
        enabled: true,
        server_name: params.sni || url.hostname,
        insecure: params.insecure === '1' || params.allowInsecure === '1',
      },
    };
    return outbound;
  }

  throw new Error(`Unsupported protocol: ${protocol}`);
}

try {
  const outboundConfig = parseProxy(rawUrl);
  const singBoxConfig = {
    log: { level: 'warn' },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 1080,
      },
    ],
    outbounds: [
      outboundConfig,
      {
        type: 'direct',
        tag: 'direct',
      },
    ],
  };

  console.log(JSON.stringify(singBoxConfig, null, 2));
} catch (e) {
  console.error('[proxy-setup] Failed to parse URL:', e.message);
  process.exit(1);
}
