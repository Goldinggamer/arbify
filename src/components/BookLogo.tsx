import { BOOKMAKER_BY_ID } from '../data/bookmakers'

const SIZES = {
  sm: 'h-6 w-6 text-[8px]',
  md: 'h-8 w-8 text-[9px]',
  lg: 'h-10 w-10 text-[11px]',
} as const

export function BookLogo({
  id,
  size = 'md',
  className = '',
}: {
  id: string
  size?: keyof typeof SIZES
  className?: string
}) {
  const b = BOOKMAKER_BY_ID[id]
  if (!b) return null
  return (
    <span
      title={b.name}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold leading-none tracking-tight ${SIZES[size]} ${className}`}
      style={{ background: b.color, color: b.fg ?? '#fff' }}
    >
      {b.short}
    </span>
  )
}

export function BookName({ id }: { id: string }) {
  return <>{BOOKMAKER_BY_ID[id]?.name ?? id}</>
}
