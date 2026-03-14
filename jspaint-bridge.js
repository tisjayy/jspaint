// jspaint-bridge.js
window.addEventListener('message', (event) => {
    const data = event.data;

    // STEP 1: Parent asks for the canvas data
    if (data.action === 'JSPAINT_GET_CANVAS') {
        if (!window._jspaintCanvas) return;
        
        const canvasData = window._jspaintCanvas.toDataURL('image/png');
        
        // Send the base64 payload back up to Jay OS
        window.parent.postMessage({
            action: 'JSPAINT_CANVAS_DATA',
            base64: canvasData,
            width: window._jspaintCanvas.width,
            height: window._jspaintCanvas.height
        }, '*');
    }

    // STEP 2: Parent sends the AI-generated image back
    if (data.action === 'JSPAINT_SET_CANVAS') {
        if (!window._jspaintCanvas || !window._jspaintUndoable) return;

        const img = new Image();
        img.onload = () => {
            const ctx = window._jspaintCanvas.getContext('2d');
            
            // Wrap the draw operation in jspaint's native undo state!
            // This ensures Ctrl+Z works to remove the AI generation.
            window._jspaintUndoable({
                name: "Magic AI Generation",
                icon: "magic", 
            }, () => {
                ctx.drawImage(img, 0, 0);
            });
        };
        img.src = data.dataURL;
    }
});