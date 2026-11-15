import { Link, NavLink, Route, Routes, useSearchParams } from 'react-router-dom'
import { ArrowRight, AudioLines, Eye, LockKeyhole } from 'lucide-react'
import BlurText from '@/components/BlurText'
import { CustomerPanel } from '@/components/CustomerPanel'
import { CounterFlow, ModeGuide } from '@/components/HomeSections'
import { MerchantPanel } from '@/components/MerchantPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import type { Provider } from '@/lib/api'

function SiteHeader() {
  return <header className="site-header"><div className="site-header__inner">
    <Link className="brand" to="/" aria-label="Copiloto Zero-UI, inicio">
      <span className="brand__mark"><AudioLines size={23} strokeWidth={2.5} aria-hidden="true" /></span>
      <span>copiloto<span className="brand__dot">.</span><small>zero-ui</small></span>
    </Link>
    <nav className="site-nav" aria-label="Navegación principal">
      <NavLink to="/" end>Inicio</NavLink><NavLink to="/demo">Demo</NavLink>
      <NavLink to="/comerciante">Comerciante</NavLink><NavLink to="/cliente">Cliente</NavLink>
    </nav>
    <Button className="site-header__cta" asChild><Link to="/demo">Abrir demo <ArrowRight aria-hidden="true" /></Link></Button>
  </div></header>
}

function Home() {
  return <>
    <main id="contenido">
      <section className="hero"><div className="hero__inner">
        <div className="hero__copy">
          <Badge variant="outline" className="hero__status"><span className="status-dot" /> Backend Pey verificado con un pago real</Badge>
          <BlurText text="El pago se comprueba. La palabra aparece." animateBy="words" trigger="load" effect="focus" delay={110} className="hero__title" />
          <p className="hero__description">El comerciante prepara el cobro y recibe una palabra privada. El cliente la ve solo cuando el servidor confirma el pago. Una demostración clara para ambos lados del mostrador.</p>
          <div className="hero__actions">
            <Button size="lg" asChild><Link to="/demo">Probar la demo sin dinero <ArrowRight aria-hidden="true" /></Link></Button>
            <Button size="lg" variant="outline" asChild><Link to="/cliente">Ver pantalla del cliente</Link></Button>
          </div>
          <p className="hero__fineprint">La demo usa MockProvider y no mueve dinero. Pey ya se probó con una transferencia real de $0.01 confirmada por webhook. El dictado web del importe ya existe en navegadores compatibles; Android, Bluetooth y el reconocimiento local propio siguen pendientes. Si el navegador no reconoce la voz en el dispositivo, el comerciante acepta antes que pueda enviarla a su servicio.</p>
        </div>
        <div className="hero__preview">
          <CustomerPanel provider="mock" compact />
        </div>
      </div></section>
      <CounterFlow />
      <ModeGuide />
    </main><Footer />
  </>
}

function Workspace({ mockOnly }: { mockOnly?: boolean }) {
  const [params, setParams] = useSearchParams()
  const provider: Provider = mockOnly ? 'mock' : params.get('modo') === 'pey' ? 'pey' : 'mock'
  const changeProvider = (next: Provider) => setParams(next === 'pey' ? { modo: 'pey' } : {})
  return <main id="contenido" className={mockOnly ? 'workspace' : 'workspace workspace--merchant'}>
    <div className="workspace__intro">
      <div>
        <h1>{mockOnly ? 'Dos lados del mismo pago.' : 'Tu puesto, bajo tu control.'}</h1>
        <p>{mockOnly ? 'Crea una orden a la izquierda y observa cuándo aparece la palabra a la derecha. Ningún pago de esta pantalla mueve dinero.' : 'Esta pantalla es privada: crea órdenes y consulta su estado aquí. Abre la vista Cliente en el otro dispositivo.'}</p>
      </div>
      <Badge variant="outline" className="workspace__mode">{provider === 'mock' ? 'Mock · sin dinero real' : 'Pey · cobro real'}</Badge>
    </div>
    <div className={mockOnly ? 'workspace__grid' : 'workspace__merchant'}>
      <section className="side side--private" aria-labelledby="side-private">
        <p className="side__bar" id="side-private"><LockKeyhole aria-hidden="true" /> Lado del comerciante · privado</p>
        <MerchantPanel key={`merchant-${provider}`} provider={provider} onProviderChange={mockOnly ? undefined : changeProvider} />
      </section>
      {mockOnly && <section className="side side--public" aria-labelledby="side-public">
        <p className="side__bar" id="side-public"><Eye aria-hidden="true" /> Lado del cliente · público</p>
        <CustomerPanel provider="mock" />
      </section>}
    </div>
  </main>
}

function CustomerPage() {
  const [params, setParams] = useSearchParams()
  const provider: Provider = params.get('modo') === 'pey' ? 'pey' : 'mock'
  return <main id="contenido" className="public-page">
    <div className="public-page__intro">
      <div><h1>Tu pago, a la vista.</h1><p>Muestra solo lo que el servidor permite ver al cliente.</p></div>
      <div className="public-page__switch" role="group" aria-label="Puesto visible">
        <Button variant={provider === 'mock' ? 'default' : 'outline'} size="sm" aria-pressed={provider === 'mock'} onClick={() => setParams({})}>Demo sin dinero</Button>
        <Button variant={provider === 'pey' ? 'default' : 'outline'} size="sm" aria-pressed={provider === 'pey'} onClick={() => setParams({ modo: 'pey' })}>Pey real</Button>
      </div>
    </div>
    <CustomerPanel key={provider} provider={provider} />
    <p className="public-page__note">El cliente no inicia sesión ni puede confirmar un pago desde esta vista.</p>
  </main>
}

function Footer() {
  return <footer className="site-footer"><div className="site-footer__inner"><Separator /><div><span>Copiloto Acústico Zero-UI</span><span>Demo web: MockProvider · Pey: pago real verificado · Dictado web del importe en navegadores compatibles · Android, Bluetooth y reconocimiento local propio: pendientes</span></div></div></footer>
}

export default function App() {
  return <div className="app-shell">
    <a className="skip-link" href="#contenido">Saltar al contenido</a>
    <SiteHeader />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/demo" element={<Workspace mockOnly />} />
      <Route path="/comerciante" element={<Workspace />} />
      <Route path="/cliente" element={<CustomerPage />} />
      <Route path="*" element={<Home />} />
    </Routes>
  </div>
}
