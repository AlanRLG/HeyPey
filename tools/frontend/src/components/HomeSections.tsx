import { Link } from 'react-router-dom'
import { ArrowRight, BanknoteArrowUp, Eye, LockKeyhole, ShieldCheck } from 'lucide-react'

type Moment = {
  title: string
  tone: 'wait' | 'paid'
  status: string
  merchant: string
  server: string
  customer: string
}

const moments: Moment[] = [
  {
    title: 'Se prepara el cobro',
    tone: 'wait',
    status: 'Esperando pago',
    merchant: 'Escribe o dicta el importe, lo revisa y después crea la orden. Dictar no cobra. La palabra privada se queda en su pantalla.',
    server: 'Registra la orden y genera el QR.',
    customer: 'Ve el importe y el QR. Todavía no hay palabra.',
  },
  {
    title: 'El cliente paga',
    tone: 'wait',
    status: 'Verificando',
    merchant: 'Espera. En la demo puede enviar un pago simulado; con Pey no puede marcar nada.',
    server: 'Comprueba firma, importe, referencia y estado con el proveedor.',
    customer: 'Sigue viendo el importe y el QR.',
  },
  {
    title: 'El servidor confirma',
    tone: 'paid',
    status: 'Pago confirmado',
    merchant: 'Ve la orden como pagada.',
    server: 'Cambia la orden a pago confirmado. Solo entonces libera la palabra.',
    customer: 'La palabra aparece en lugar del QR.',
  },
]

export function CounterFlow() {
  return (
    <section className="counter-flow" aria-labelledby="flow-heading">
      <div className="counter-flow__inner">
        <div className="counter-flow__intro">
          <h2 id="flow-heading">Dos pantallas, un servidor.</h2>
          <p>
            El comerciante y el cliente miran cada uno su pantalla. Ninguna acción del navegador cambia el estado de un pago: lo decide el servidor.
          </p>
        </div>
        <ol className="counter-flow__rows">
          {moments.map((moment, index) => (
            <li key={moment.title} className={'counter-row counter-row--' + moment.tone}>
              <div className="counter-row__head">
                <span className="counter-row__index" aria-hidden="true">{index + 1}</span>
                <div>
                  <h3>{moment.title}</h3>
                  <span className="counter-row__status">{moment.status}</span>
                </div>
              </div>
              <div className="counter-cell counter-cell--merchant">
                <p className="counter-cell__who"><LockKeyhole aria-hidden="true" /> Comerciante · privado</p>
                <p>{moment.merchant}</p>
              </div>
              <div className="counter-cell counter-cell--server">
                <p className="counter-cell__who"><ShieldCheck aria-hidden="true" /> Servidor</p>
                <p>{moment.server}</p>
              </div>
              <div className="counter-cell counter-cell--customer">
                <p className="counter-cell__who"><Eye aria-hidden="true" /> Cliente · público</p>
                <p>{moment.customer}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

export function ModeGuide() {
  return (
    <section className="mode-guide" aria-labelledby="modes-heading">
      <div className="mode-guide__inner">
        <h2 id="modes-heading">Dos puestos, bien separados.</h2>
        <div className="mode-guide__grid">
          <article className="mode-card mode-card--mock">
            <p className="mode-card__tag"><BanknoteArrowUp aria-hidden="true" /> Demo simulada</p>
            <h3>Sin dinero real</h3>
            <p>
              El recorrido público muestra las dos pantallas y simula un QR y un pago en tu navegador. Puedes completarlo sin iniciar sesión ni mover dinero.
            </p>
            <Link className="mode-card__link" to="/demo">Abrir la demo <ArrowRight aria-hidden="true" /></Link>
          </article>
          <article className="mode-card mode-card--pey">
            <p className="mode-card__tag"><ShieldCheck aria-hidden="true" /> Pey real</p>
            <h3>Pago real, con acceso</h3>
            <p>
              Una transferencia real de $0.01 llegó a pago confirmado por webhook. Crear un QR real exige iniciar sesión como comerciante y confirmar dos veces.
            </p>
            <div className="mode-card__links">
              <Link className="mode-card__link" to="/cliente?modo=pey">Ver pantalla pública Pey <ArrowRight aria-hidden="true" /></Link>
              <Link className="mode-card__link" to="/comerciante?modo=pey">Entrar como comerciante <ArrowRight aria-hidden="true" /></Link>
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}
