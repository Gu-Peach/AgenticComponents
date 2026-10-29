import Image from "next/image";

/** The project identity uses its own AC monogram, separate from device icons. */
export function ProjectMark({ size = 29 }: { size?: number }) {
  return (
    <Image
      src="/assets/agentic-mark.svg"
      alt="Agentic Components 标识"
      width={size}
      height={size}
      unoptimized
    />
  );
}
