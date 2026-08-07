import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Home }      from './pages/Home'
import { Login }     from './pages/Login'
import { Dashboard } from './pages/dashboard/Dashboard'
import { CookieBanner } from './components/ui/CookieBanner'
import { ThemeProvider } from './context/ThemeContext'
import { I18nProvider }  from './context/I18nContext'
import { isAuthenticated } from './lib/auth'

// ── Error Boundary ────────────────────────────────────────────
// Sits above ThemeProvider/I18nProvider on purpose (it must survive if one
// of them throws), so it can't consume useI18n() — instead it reads the
// persisted language directly, same source I18nContext uses.
const ERROR_MESSAGES: Record<string, { title: string; back: string }> = {
  fr: { title: 'Une erreur est survenue', back: "Retour à l'accueil" },
  en: { title: 'An error occurred', back: 'Back to home' },
  de: { title: 'Ein Fehler ist aufgetreten', back: 'Zurück zur Startseite' },
  es: { title: 'Se ha producido un error', back: 'Volver al inicio' },
  pt: { title: 'Ocorreu um erro', back: 'Voltar ao início' },
  pl: { title: 'Wystąpił błąd', back: 'Powrót do strony głównej' },
  ru: { title: 'Произошла ошибка', back: 'Вернуться на главную' },
  it: { title: 'Si è verificato un errore', back: 'Torna alla home' },
}

function errorBoundaryMessages() {
  const lang = localStorage.getItem('lang') ?? 'fr'
  return ERROR_MESSAGES[lang] ?? ERROR_MESSAGES.fr
}

interface ErrorBoundaryState { hasError: boolean; message: string }

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      const msgs = errorBoundaryMessages()
      return (
        <div className="min-h-screen bg-surface flex flex-col items-center justify-center gap-4 px-4">
          <div className="card max-w-md w-full p-8 text-center space-y-4">
            <p className="text-2xl font-bold text-red-400">{msgs.title}</p>
            <p className="text-sm text-zinc-500">{this.state.message}</p>
            <button
              onClick={() => { this.setState({ hasError: false, message: '' }); window.location.href = '/' }}
              className="btn-accent mx-auto"
            >
              {msgs.back}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Private route ─────────────────────────────────────────────
function PrivateRoute({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />
  return <>{children}</>
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <I18nProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route
                path="/dashboard"
                element={<PrivateRoute><Dashboard /></PrivateRoute>}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <CookieBanner />
          </BrowserRouter>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
