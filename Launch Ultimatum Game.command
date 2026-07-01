#!/bin/bash
# Launch Ultimatum Game on macOS

# Navigate to the script's directory
cd "$(dirname "$0")"

# Start Python HTTP server in background
echo "Starting server on http://localhost:8777..."
python3 -m http.server 8777 --directory "Ultimatum Game/web" &

# Wait for server to start
sleep 2

# Open in default browser
open http://localhost:8777

echo "Game launched! Press Ctrl+C to stop the server when done."
wait
