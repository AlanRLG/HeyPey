import { Link, NavLink, Route, Routes, useSearchParams } from 'react-router-dom'
import { ArrowRight, AudioLines, BanknoteArrowUp, CheckCheck, ShieldCheck } from 'lucide-react'
import BlurText from '@/components/BlurText'
import { CustomerPanel } from '@/components/CustomerPanel'
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
          <p className="hero__fineprint">La demo usa MockProvider. Pey ya se probó con una transferencia real de $0.01 y un webhook verificado.</p>
        </div>
        <div className="hero__preview">
          <div className="hero__preview-label"><span className="live-dot" /> Pantalla pública · datos de la demo</div>
          <CustomerPanel provider="mock" compact />
        </div>
      </div></section>
      <section className="flow" aria-labelledby="flow-heading"><div className="flow__inner">
        <div className="flow__intro"><h2 id="flow-heading">De cobrar a entregar, sin adivinar.</h2><p>El QR inicia la espera. El webhook confirmado cambia la orden. La palabra cierra la entrega.</p></div>
        <ol className="flow__steps">
          <li><BanknoteArrowUp aria-hidden="true" /><div><strong>El comerciante crea la orden</strong><span>Ve el importe y conserva la palabra en privado.</span></div></li>
          <li><ShieldCheck aria-hidden="true" /><div><strong>El servidor verifica el pago</strong><span>Comprueba firma, importe, referencia y estado.</span></div></li>
          <li><CheckCheck aria-hidden="true" /><div><strong>El cliente recibe la palabra</strong><span>Solo cuando la orden llega a pago confirmado.</span></div></li>
        </ol>
      </div></section>
    </main><Footer />
  </>
}

function Workspace({ mockOnly }: { mockOnly?: boolean }) {
  const [params, setParams] = useSearchParams()
  const provider: Provider = mockOnly ? 'mock' : params.get('modo') === 'pey' ? 'pey' : 'mock'
  const changeProvider = (next: Provider) => setParams(next === 'pey' ? { modo: 'pey' } : {})
  return <main id="contenido" className={mockOnly ? 'workspace' : 'workspace workspace--merchant'}>
    <div className="workspace__intro">
      <div><p className="surface-label">{mockOnly ? 'Demostración segura' : 'Mesa de cobro'}</p>
        <h1>{mockOnly ? 'Dos lados del mismo pago.' : 'Tu puesto, bajo tu control.'}</h1>
        <p>{mockOnly ? 'Crea una orden a la izquierda y observa cuándo aparece la palabra a la derecha. Ningún pago de esta pantalla mueve dinero.' : 'Esta pantalla es privada: crea órdenes y consulta su estado aquí. Abre la vista Cliente en el otro dispositivo.'}</p>
      </div>
      <Badge variant="outline" className="workspace__mode">{provider === 'mock' ? 'Mock · sin dinero real' : 'Pey · cobro real'}</Badge>
    </div>
    <div className={mockOnly ? 'workspace__grid' : 'workspace__merchant'}>
      <MerchantPanel key={`merchant-${provider}`} provider={provider} onProviderChange={mockOnly ? undefined : changeProvider} />
      {mockOnly && <CustomerPanel provider="mock" />}
    </div>
  </main>
}

function CustomerPage() {
  const [params, setParams] = useSearchParams()
  const provider: Provider = params.get('modo') === 'pey' ? 'pey' : 'mock'
  return <main id="contenido" className="public-page">
    <div className="public-page__intro">
      <div><p className="surface-label">Vista pública</p><h1>Tu pago, a la vista.</h1><p>Esta pantalla consulta directamente el estado que el servidor permite mostrar al cliente.</p></div>
      <div className="public-page__switch" role="group" aria-label="Puesto visible">
        <Button variant={provider === 'mock' ? 'default' : 'outline'} size="sm" onClick={() => setParams({})}>Demo</Button>
        <Button variant={provider === 'pey' ? 'default' : 'outline'} size="sm" onClick={() => setParams({ modo: 'pey' })}>Pey real</Button>
      </div>
    </div>
    <CustomerPanel key={provider} provider={provider} />
    <p className="public-page__note">El cliente no inicia sesión ni puede confirmar un pago desde esta vista.</p>
  </main>
}

function Footer() {
  return <footer className="site-footer"><div className="site-footer__inner"><Separator /><div><span>Copiloto Acústico Zero-UI</span><span>Demo web: MockProvider · Backend Pey: pago real verificado · Voz y Android: pendientes</span></div></div></footer>
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
