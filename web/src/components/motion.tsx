import { animate, motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const ease = [0.22, 1, 0.36, 1] as const;

/** Page enter animation (used by the layout around every page). */
export function PageTransition({ children, id }: { children: ReactNode; id: string }) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease }}
    >
      {children}
    </motion.div>
  );
}

const staggerParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
const staggerChild = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
};

export function Stagger({ children, className, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div variants={staggerParent} initial="hidden" animate="show" className={className} {...rest}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div variants={staggerChild} className={className} {...rest}>
      {children}
    </motion.div>
  );
}

/** Number that counts up to its value. Shows the final value at once when motion is reduced. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const controls = animate(from.current, value, {
      duration: 0.9,
      ease,
      onUpdate: (v) => setShown(Math.round(v)),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, reduce]);
  return <span className={className}>{shown}</span>;
}

/** Small dot that pulses when active (e.g. machine online). */
export function PulseDot({
  tone = 'green',
  active = true,
}: {
  tone?: 'green' | 'amber' | 'red' | 'gray';
  active?: boolean;
}) {
  const colour = {
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-rose-500',
    gray: 'bg-slate-400',
  }[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      {active && <span className={`absolute inset-0 rounded-full ${colour} animate-pulse-ring`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colour}`} />
    </span>
  );
}
