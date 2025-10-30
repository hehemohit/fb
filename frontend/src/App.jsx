import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = 'http://localhost:4000'

function Home() {
  const handleConnect = () => {
    window.location.href = `${API_BASE}/auth/facebook`
  }
  return (
    <div className="card">
      <h2>Connect Facebook</h2>
      <button onClick={handleConnect}>Connect Facebook</button>
    </div>
  )
}

function SelectPage() {
  const [pages, setPages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [saved, setSaved] = useState(false)
  const [pageName, setPageName] = useState('')

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/pages`, { credentials: 'include' })
        if (!res.ok) throw new Error('Unauthorized')
        const data = await res.json()
        setPages(data)
        if (data?.length) {
          setSelected(data[0].id)
          setPageName(data[0].name)
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    run()
  }, [])

  const selectedPageToken = useMemo(() => {
    const p = pages.find(p => p.id === selected)
    return p?.access_token || ''
  }, [pages, selected])

  const savePage = async () => {
    if (!selected) return
    const body = {
      pageId: selected,
      pageName,
      pageAccessToken: selectedPageToken,
    }
    const res = await fetch(`${API_BASE}/api/pages/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (res.ok) setSaved(true)
  }

  if (loading) return <p>Loading pages…</p>
  if (error) return <p style={{ color: 'red' }}>{error}</p>

  return (
    <div className="card">
      <h2>Select Page</h2>
      <select value={selected} onChange={(e) => {
        setSelected(e.target.value)
        const p = pages.find(pp => pp.id === e.target.value)
        setPageName(p?.name || '')
      }}>
        {pages.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button onClick={savePage} disabled={!selectedPageToken}>Save Page</button>
      {saved && <Composer pageId={selected} />}
    </div>
  )
}

function Composer({ pageId }) {
  const [message, setMessage] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [result, setResult] = useState('')

  const postText = async () => {
    const res = await fetch(`${API_BASE}/api/post/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, message }),
    })
    const data = await res.json()
    setResult(JSON.stringify(data))
  }

  const postPhoto = async () => {
    const res = await fetch(`${API_BASE}/api/post/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, message, imageUrl }),
    })
    const data = await res.json()
    setResult(JSON.stringify(data))
  }

  return (
    <div style={{ marginTop: 20 }}>
      <h3>Create Post</h3>
      <textarea
        placeholder="Message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{ width: '100%' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={postText} disabled={!message}>Post Text</button>
        <input
          placeholder="Image URL (optional)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={postPhoto} disabled={!imageUrl}>Post Photo</button>
      </div>
      {result && (
        <pre style={{ marginTop: 12 }}>{result}</pre>
      )}
    </div>
  )
}

function App() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path === '/select-page') return <SelectPage />
  return <Home />
}

export default App
