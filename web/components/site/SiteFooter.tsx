import Link from "next/link";

export const SOURCE_URL = "https://github.com/rohitshukla11/likeness-hsk";

/** Footer from the landing mockup, shared by every page. */
export function SiteFooter() {
  return (
    <footer className="on-dark bg-ink text-white">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-12 px-4 pb-9 pt-[72px] sm:px-8">
        <div className="flex flex-wrap justify-between gap-8">
          <h2 className="m-0 font-display text-[clamp(22px,3vw,30px)] font-extrabold leading-[1.3]">
            THE FUTURE OF YOUR
            <br />
            LIKENESS IS YOURS
          </h2>
          <div className="flex flex-col gap-3 text-[15px] text-grey-dark">
            <span className="text-white">License your face to AI. Your terms, paid per image.</span>
            <span>HSK Chain testnet · paid through HSP · test tokens, no value</span>
            <Link href="/how" className="text-grey-dark underline-offset-2 hover:text-white hover:underline">
              How the agents pay
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-4 border-t border-ink-line pt-6 text-[14px] text-grey-dark">
          <span className="flex flex-wrap gap-6">
            <Link href="/#how" className="text-grey-dark hover:text-white">
              How it works
            </Link>
            <Link href="/creators" className="text-grey-dark hover:text-white">
              Creators
            </Link>
            <Link href="/how#contracts" className="text-grey-dark hover:text-white">
              Contracts
            </Link>
            <a href="/console" className="text-grey-dark hover:text-white">
              Console
            </a>
            <a href={SOURCE_URL} className="text-grey-dark hover:text-white" target="_blank" rel="noreferrer">
              Source<span className="sr-only"> (opens GitHub)</span>
            </a>
          </span>
          <span>© 2026 Likeness</span>
        </div>
      </div>
    </footer>
  );
}
