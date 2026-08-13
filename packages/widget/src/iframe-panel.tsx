import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Panel } from './panel.js'
import type { WidgetController } from './types.js'

export function IframePanel({
  controller,
  close,
  styleText,
}: {
  controller: WidgetController
  close: () => void
  styleText: string
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    const mount = () => {
      const doc = frame.contentDocument
      const root = doc?.getElementById('sitebot-panel')
      if (!doc || !root) return
      const style = doc.createElement('style')
      style.textContent = styleText
      doc.head.append(style)
      render(<Panel controller={controller} close={close} />, root)
    }
    frame.addEventListener('load', mount)
    if (frame.contentDocument?.readyState === 'complete') mount()
    return () => frame.removeEventListener('load', mount)
  }, [controller, close, styleText])
  return (
    <iframe
      ref={ref}
      class="panel-frame"
      title={controller.config.ui.a11y.panelAriaLabel}
      srcdoc={
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="sitebot-panel"></div></body></html>'
      }
    />
  )
}
