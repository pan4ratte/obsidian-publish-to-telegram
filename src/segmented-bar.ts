// segmented-bar.ts
// The mechanics behind the plugin's segmented tab bars — the account bar at the head of the
// settings and the insert window's element tabs: one accent underline that slides between
// segments, segments of equal width, and a panel area whose height follows the panel it holds.
// The look is in styles.css (`.telegram-auth-status` and the rules after it).

// How long a panel being replaced takes to fade out (`.telegram-auth-stage .is-leaving` in
// styles.css); it's removed once this has run.
export const PANEL_EXIT_MS = 90;

// Puts the bar's accent underline under `btn`, or fades it out when no segment is lit.
//
// The underline is one line for the whole bar, not a border per segment, so that picking
// another tab slides it across rather than swapping one line for another. It is positioned
// against the bar (the only positioned ancestor, so the segments' offsets are already in its
// coordinates) and sits on the 2px strip every segment reserves.
export function moveSegmentIndicator(indicatorEl: HTMLElement, btn: HTMLElement | null, instant = false): void {
    // Appearing is not travelling. A line that isn't on screen yet has no position worth
    // animating from — it would fly in from wherever it was last left, or from the bar's
    // top-left corner on the first open — so it is placed outright and only fades in.
    // Sliding is for a move between two lit tabs.
    const jump = instant || !indicatorEl.hasClass("is-visible");
    if (jump) indicatorEl.addClass("is-instant");
    // With no tab lit the line just fades where it stands — it has nowhere to go, and
    // sliding it to a corner on the way out would only draw the eye.
    if (btn) {
        indicatorEl.style.left = `${btn.offsetLeft}px`;
        indicatorEl.style.top = `${btn.offsetTop + btn.offsetHeight - 2}px`;
        indicatorEl.style.width = `${btn.offsetWidth}px`;
    }
    indicatorEl.toggleClass("is-visible", btn !== null);
    if (jump) {
        // Commit the placement while transitions are still off. Without this read the
        // browser never computes the intermediate style: it coalesces the move and the
        // re-enabling into one change and animates the jump after all.
        indicatorEl.getBoundingClientRect();
        indicatorEl.removeClass("is-instant");
    }
}

// Segments sharing a row all start from the width the widest label needs, so they come out
// equal; a bar too narrow for that many wraps instead (see styles.css). A Range over a
// segment's contents spans its icon and label at their natural size, whatever width the
// segment itself has been given. A bar that isn't laid out yet measures nothing, and is left
// to size its segments by their own labels until it is.
export function equalizeSegments(barEl: HTMLElement, segments: HTMLElement[]): void {
    let widest = 0;
    for (const segment of segments) {
        const range = segment.doc.createRange();
        range.selectNodeContents(segment);
        const style = segment.win.getComputedStyle(segment);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        widest = Math.max(widest, range.getBoundingClientRect().width + padding);
    }
    if (widest === 0) return;
    const width = `${Math.ceil(widest)}px`;
    if (barEl.style.getPropertyValue("--telegram-segment-width") !== width) {
        barEl.setCssProps({ "--telegram-segment-width": width });
    }
}

// Keeps a bar's segments equal and its underline under `activeTab()` while the bar is laid out,
// resized or rewrapped. The bar has no measurable width until it is laid out, so the first
// observation is what places the line; later ones follow the segments when the pane is resized,
// the bar rewraps or a label changes width. The segments are watched alongside the bar because
// they can resize without it doing so. None of these are tab changes, so the line is placed
// outright rather than sliding. The segments are re-measured on the next frame rather than in
// the observer's own callback, which would have it report a loop.
export function watchSegments(
    barEl: HTMLElement,
    actionsEl: HTMLElement,
    segments: HTMLElement[],
    indicatorEl: HTMLElement,
    activeTab: () => HTMLElement | null,
): ResizeObserver {
    const observer = new ResizeObserver(() => {
        moveSegmentIndicator(indicatorEl, activeTab(), true);
        window.requestAnimationFrame(() => equalizeSegments(actionsEl, segments));
    });
    for (const el of [barEl, ...segments]) observer.observe(el);
    return observer;
}

// Animates the panel area's height to follow the panel inside it (see `.telegram-auth-stage`
// in styles.css). The stage's height covers its padding as well as its contents (border-box),
// and that padding is fixed by the stylesheet — read once rather than measured per change.
export function watchStageHeight(stageEl: HTMLElement, innerEl: HTMLElement): ResizeObserver {
    const padding = parseFloat(getComputedStyle(stageEl).paddingTop) || 0;
    const observer = new ResizeObserver(entries => {
        const box = entries[entries.length - 1].borderBoxSize?.[0];
        const content = box ? box.blockSize : innerEl.offsetHeight;
        // The first pin is the state the bar renders in: the height it names is the height
        // the stage already has, so it settles there without animating.
        stageEl.style.height = `${content + padding}px`;
    });
    observer.observe(innerEl);
    return observer;
}
