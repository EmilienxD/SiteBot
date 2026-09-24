import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Panel, PanelBoundary, type PanelProps } from './panel.js'

/**
 * `ui.isolation: iframe` — docs/07-widget.md §2.
 *
 * The panel renders into a same-origin `about:blank` frame instead of the
 * shadow root, so the host page's stylesheets cannot reach it by any selector,
 * and it gets its own document for `:focus`, `dir` and zoom. The launcher
 * stays in the shadow root either way.
 *
 * The frame's document is built with DOM calls rather than `srcdoc`: `srcdoc`
 * navigates, which replaces whatever document the frame had when it was
 * inserted, so there is no moment at which it is both loaded and ours. Some
 * engines also swap the initial `about:blank` on `load` — hence the re-mount
 * from the `load` listener when our root has gone.
 *
 * The bridge between the frame and the page is the JS realm: the component
 * tree and the chat controller live in the parent window and render *into* the
 * frame's document. Client tools therefore execute in the parent realm, against
 * the parent document, with no message passing to get wrong — `highlight`
 * scrolls the host page, not the frame.
 */
export interface IframePanelProps extends PanelProps {
  /** The widget stylesheet; `:host` is rewritten to `:root` for the frame. */
  styleText: string
  /** `--sb-*` overrides set on the host element (theme, geometry). */
  variables: string
  theme: string
}

export function frameStyles(styleText: string): string {
  return (
    styleText.replace(/:host\(([^)]*)\)/g, ':root$1').replace(/:host/g, ':root') +
    'html,body{margin:0;height:100%;background:transparent}'
  )
}

export function IframePanel(props: IframePanelProps) {
  const { controller, close, offline, styleText, variables, theme } = props
  const ref = useRef<HTMLIFrameElement>(null)
  const ui = controller.config.ui
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let root: HTMLElement | null = null
    const mount = () => {
      const doc = frame.contentDocument
      if (!doc?.body) return
      root = doc.getElementById('sitebot-panel')
      if (!root) {
        const viewport = doc.createElement('meta')
        viewport.name = 'viewport'
        viewport.content = 'width=device-width,initial-scale=1'
        doc.head.append(viewport)
        root = doc.createElement('div')
        root.id = 'sitebot-panel'
        doc.body.append(root)
      }
      doc.documentElement.dataset.theme = theme
      doc.documentElement.setAttribute('style', variables)
      doc.documentElement.lang = document.documentElement.lang
      let style = doc.getElementById('sitebot-style')
      if (!style) {
        style = doc.createElement('style')
        style.id = 'sitebot-style'
        doc.head.append(style)
      }
      style.textContent = frameStyles(styleText)
      render(
        <PanelBoundary close={close}>
          <Panel controller={controller} close={close} offline={offline} framed />
        </PanelBoundary>,
        root,
      )
    }
    frame.addEventListener('load', mount)
    mount()
    return () => {
      frame.removeEventListener('load', mount)
      if (root) render(null, root)
    }
  }, [controller, close, offline, styleText, variables, theme])
  return (
    <iframe
      ref={ref}
      class={`panel-frame${ui.position === 'bottom-left' ? ' left' : ''}`}
      title={ui.a11y.panelAriaLabel}
    />
  )
}
