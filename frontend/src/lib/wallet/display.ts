export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatNetworkLabel(network: string): string {
  if (!network) return 'Testnet';
  return network.charAt(0).toUpperCase() + network.slice(1);
}
