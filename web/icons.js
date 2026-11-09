// Authored SVG geometry, shared by static controls and rendered editor states.
export function icon(name, extraClass='') {
  return `<svg class="ui-icon ${extraClass}" aria-hidden="true" focusable="false"><use href="icons.svg#${name}"></use></svg>`;
}
