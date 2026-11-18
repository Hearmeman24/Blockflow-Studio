/**
 * jsdom stubs for @ui-sdk popups, as documented by the SDK
 * (node_modules/@ui-sdk/react/docs/core.md, "Testing in a Framework").
 * jsdom has no top layer, popover API or Web Animations; these stubs let a
 * popup render so tests can assert its contents and keyboard behaviour.
 * Import this module before rendering any component that opens an SDK popup.
 */
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.showPopover ??= function showPopover() {}
  HTMLElement.prototype.hidePopover ??= function hidePopover() {}
  Element.prototype.getAnimations ??= () => []
  if (!document.head.querySelector('style[data-ui-sdk-jsdom]')) {
    const style = document.createElement('style')
    style.setAttribute('data-ui-sdk-jsdom', '')
    style.textContent = '[popover] { display: block !important }'
    document.head.append(style)
  }
}

export {}
