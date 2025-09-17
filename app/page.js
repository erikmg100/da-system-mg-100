'use client'

import { useState } from 'react'

export default function Home() {
  const [isRecording, setIsRecording] = useState(false)
  const [response, setResponse] = useState('')

  const handleStartRecording = () => {
    setIsRecording(!isRecording)
    // Add your logic here
  }

  return (
    <main className="container">
      <h1>AI Speech Assistant</h1>
      <p>Your AI-powered speech assistant</p>
      
      <div className="controls">
        <button 
          onClick={handleStartRecording}
          className={isRecording ? 'recording' : ''}
        >
          {isRecording ? 'Listening...' : 'Start Conversation'}
        </button>
      </div>
      
      {response && (
        <div className="response">
          <h3>AI Response:</h3>
          <p>{response}</p>
        </div>
      )}
    </main>
  )
}
