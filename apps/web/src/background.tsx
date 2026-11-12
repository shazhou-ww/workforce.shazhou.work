import type { SVGProps } from "react";
import { EngravedBackground, mistPalette } from "react-engraved-background";

function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-5 -5 34 34" {...props}>
      <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />
    </svg>
  );
}

function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-5 -5 34 34" {...props}>
      <circle cx="6" cy="5" r="3" />
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="20" r="3" />
      <path d="M6 8v9m12-9v2a5 5 0 0 1-5 5H6" />
    </svg>
  );
}

function ActivityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-5 -5 34 34" {...props}>
      <path d="M3 3v18h18M6 15l4-5 5 3 6-8" />
    </svg>
  );
}

const icons = [CodeIcon, BranchIcon, ActivityIcon];

export function WorkforceBackground() {
  return (
    <EngravedBackground
      className="workforce-background"
      icons={icons}
      palette={mistPalette}
      seed="workforce-v1"
      engraving={{ style: "paper", depth: 0.22 }}
      spacing={132}
      iconSize={[44, 68]}
      aria-hidden="true"
      style={{ position: "fixed", inset: 0, zIndex: -1 }}
    />
  );
}
