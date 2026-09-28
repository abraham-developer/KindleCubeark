// apps/web/src/reader/PageTurn.tsx — wrapper con la animación de volteo 3D
// (perspective + rotateY + sombra dinámica); en modo noche, fade simple.
// Se remonta por página: `key={page}` + `direction` eligen la animación.
export default function PageTurn({
  direction = 'next',
  night = false,
  className,
  children,
}: {
  direction?: 'next' | 'prev'
  night?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`page-turn ${direction === 'prev' ? 'turn-prev' : 'turn-next'} ${night ? 'night' : ''} ${className ?? ''}`}
      data-direction={direction}
    >
      {children}
    </div>
  )
}