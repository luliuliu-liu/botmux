import {createRoot} from 'react-dom/client';
import {V3RunsPage} from '../../src/dashboard/web/v3-components.js';
import '../../src/dashboard/web/style.css';

createRoot(document.getElementById('root')!).render(<V3RunsPage/>);
