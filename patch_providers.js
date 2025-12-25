// Replace fetchWatchProviders to include provider IDs
const oldCode = `const providers = streaming.slice(0, 3).map(p => ({
        name: p.provider_name,
        logo: \`https://image.tmdb.org/t/p/w45\${p.logo_path}\`
      }));`;

const newCode = `const providers = streaming.slice(0, 3).map(p => ({
        id: p.provider_id,
        name: p.provider_name,
        logo: \`https://image.tmdb.org/t/p/w45\${p.logo_path}\`
      }));
      
      // Store all provider IDs for filtering
      const allProviderIds = streaming.map(p => p.provider_id);`;

require('fs').readFileSync('script.js', 'utf8');
