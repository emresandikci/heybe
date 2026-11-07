import { BlockList, isIP } from "node:net";

export function isIpOrSubnet(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash < 0) return isIP(value) !== 0;
  const kind = isIP(value.slice(0, slash));
  const bits = value.slice(slash + 1);
  return (
    kind !== 0 &&
    /^(0|[1-9]\d*)$/.test(bits) &&
    Number(bits) <= (kind === 4 ? 32 : 128)
  );
}

export function isIpInList(list: string[], ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  const blocks = new BlockList();
  for (const item of list) {
    const [addr, bits] = item.split("/");
    const itemKind = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) blocks.addAddress(addr, itemKind);
    else blocks.addSubnet(addr, Number(bits), itemKind);
  }
  return blocks.check(ip, kind === 6 ? "ipv6" : "ipv4");
}
