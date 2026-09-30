import os from 'node:os';

const VIRTUAL = /(vethernet|virtual|vmware|vbox|hyper-v|docker|wsl|loopback|tailscale|zerotier|bluetooth|utun|vpn)/i;

/** All private IPv4 addresses of this machine, best guess first. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name), priv });
    }
  }
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(b.priv) - Number(a.priv) || (a.address.startsWith('192.168.') ? -1 : 1));
  return out;
}

export const isLoopback = (addr = '') => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
