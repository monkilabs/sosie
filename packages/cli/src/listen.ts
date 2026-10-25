/** Whether an address is reachable from this machine only. */
export function loopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}
