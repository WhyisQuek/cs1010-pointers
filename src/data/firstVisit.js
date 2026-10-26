/** Whether this browser has opened PointerViz before, so a first visit can open Start here. */
const VISITED_KEY = 'pointerviz.visited.v1';

/** True the first time it is called in this browser; later visits, including reloads, get false. */
export function firstVisit() {
  try {
    if (localStorage.getItem(VISITED_KEY)) return false;
    localStorage.setItem(VISITED_KEY, '1');
  } catch {
    /* storage blocked: every visit counts as the first, which only means opening Start here */
  }
  return true;
}
