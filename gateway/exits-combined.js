// Free public servers by country + your own servers (e.g. Webshare) as separate choices.
// Exit ids: "US" = free servers in that country, "P3" = your server number 3.
export function combineExits({ publicExits = null, privateExits = null }) {
  if (!publicExits && !privateExits) return null;
  const isPrivate = (exit) => /^P\d+$/.test(exit);
  return {
    source: privateExits ? 'mixed' : 'public',
    countries: async () => (publicExits ? publicExits.countries() : []),
    servers: async () => (privateExits?.servers ? privateExits.servers() : []),
    async pick(exit, n) {
      const from = isPrivate(exit) ? privateExits : publicExits;
      if (!from) return [];
      return (await from.pick(exit, n)).map((p) => ({ ...p, _from: from }));
    },
    ok(p) { p._from?.ok?.(p); },
    fail(p) { p._from?.fail?.(p); },
  };
}
