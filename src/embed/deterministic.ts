export function createDeterministicEmbedding(
  text: string,
  dimensions: number,
  salt = ""
): number[] {
  const embedding: number[] = [];
  let seed = 0;
  const input = `${salt}:${text}`;

  for (let i = 0; i < input.length; i += 1) {
    seed = (seed << 5) - seed + input.charCodeAt(i);
    seed &= 0x7fffffff;
  }

  for (let i = 0; i < dimensions; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    embedding.push((seed / 0x7fffffff) * 2 - 1);
  }

  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return Array.from({ length: dimensions }, () => 0);
  }

  return embedding.map((value) => value / magnitude);
}
