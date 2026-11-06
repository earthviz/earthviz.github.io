// Cooperative time-slicing so heavy per-tile work never blocks a frame.

export function nextTask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Runs fn over items, yielding to the browser whenever a slice exceeds
// budgetMs. Returns false if isActive() turned false (work abandoned).
export async function forEachSliced(items, fn, options = {}) {
  const {
    budgetMs = 4,
    now = () => performance.now(),
    yieldFn = nextTask,
    isActive = () => true,
  } = options;
  let sliceStart = now();
  for (let index = 0; index < items.length; index += 1) {
    fn(items[index], index);
    if (now() - sliceStart >= budgetMs) {
      await yieldFn();
      if (!isActive()) return false;
      sliceStart = now();
    }
  }
  return isActive();
}
